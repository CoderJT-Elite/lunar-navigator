import { setEphemeris, ephemerisRange, vectorsAt, siteFrame, skyAt, maskAt, R_MOON, R_SUN } from "./engine.js";
import { Terrain, unpack } from "./terrain.js";
import { initPole } from "./pole.js?v=4";
import { initMoon } from "./moon.js?v=4";
let pole = null;

const $ = (s, el = document) => el.querySelector(s);
const DAY = 86400000, HOUR = 3600000, DEG = Math.PI / 180;
const MAX_SITES = 5, SPAN_DAYS = 365;
const fmtDate = t => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDT = t => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
const iso = t => new Date(t).toISOString().slice(0, 10);
const hours = h => h >= 48 ? (h / 24).toFixed(1) + " days" : Math.round(h) + " h";

// Colours come from the tokens in styles.css, so the canvases and the page can never drift apart.
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const col = n => css("--color-" + n);
const rgbCache = new Map();
function rgb(n) {
  if (!rgbCache.has(n)) {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = col(n); g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; rgbCache.set(n, [d[0], d[1], d[2]]);
  }
  return rgbCache.get(n);
}
const rgba = (n, a) => { const c = rgb(n); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const FONT = "'Albert Sans', system-ui, sans-serif";

const state = {
  sites: [], byId: new Map(), selected: [], date: Date.UTC(2027, 5, 1), dur: 7, bat: 60, link: 40, minel: 5,
  rs: undefined, tfrac: 0, playing: false, terrain: null, terrainLoading: null, eph: null,
};
const cache = new Map();   // hourly series per site

// ---------- loading ----------
async function boot() {
  const head = $("#headline"), sub = $("#subline");
  try {
    const [eph, cat] = await Promise.all([fetch("data/ephem.bin").then(r => { if (!r.ok) throw new Error("ephemeris"); return r.arrayBuffer(); }),
                                          fetch("data/sites.json").then(r => { if (!r.ok) throw new Error("sites"); return r.json(); })]);
    setEphemeris(eph); state.eph = ephemerisRange();
    for (const s of cat.sites) addSite({ ...s, mask: s.mask ? Float32Array.from(s.mask) : null });
  } catch (e) {
    head.textContent = "The data files did not load.";
    sub.textContent = "Missing: " + e.message + ". Serve this folder over http (for example: python -m http.server) and reload.";
    return;
  }
  const hadDate = /(^|&)d=/.test(location.hash.slice(1));
  readHash();
  if (!state.selected.length) state.selected = ["connecting-ridge", "malapert-massif", "mons-mouton", "nobile-rim", "haworth"];
  if (!hadDate) firstViableDate();
  buildSiteList(); wire(); syncInputs();
  initMoon({ canvas: $("#globe") });
  pole = initPole({
    canvas: $("#pole"), slider: $("#poleT"), clock: $("#poleClock"), play: $("#polePlay"), read: $("#poleRead"),
    getTerrain: loadTerrain, getSites: () => state.selected.map(id => state.byId.get(id)).filter(Boolean),
    onStatus: m => { if (m) $("#poleRead").textContent = m; },
  });
  render();
}
// Open on a landing date where at least two of the default sites meet the limits, so the first screen shows a real comparison.
function firstViableDate() {
  const rows = state.selected.map(id => state.byId.get(id)), start = Date.UTC(2027, 0, 1), w = state.dur * 24;
  const ser = rows.map(s => series(s, start, start + (200 + state.dur) * DAY));
  for (let d = 150; d < 200; d++) {
    const n = ser.filter(s => verdict(windowMetrics(s, d * 24, w)).ok).length;
    if (n >= 2) { state.date = start + d * DAY; return; }
  }
}
function addSite(s) {
  s.frame = siteFrame(s.lat, s.lon);
  state.sites.push(s); state.byId.set(s.id, s);
}

// ---------- hash state ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const d = Date.parse(p.get("d") + "T00:00:00Z"); if (!isNaN(d)) state.date = d;
  const n = +p.get("n"); if (n >= 2 && n <= 30) state.dur = n;
  const s = (p.get("s") || "").split(",").filter(id => state.byId.has(id)).slice(0, MAX_SITES); if (s.length) state.selected = s;
  for (const k of ["bat", "link", "minel"]) { const v = +p.get(k); if (p.has(k) && !isNaN(v)) state[k] = v; }
}
function writeHash() {
  const p = new URLSearchParams({ d: iso(state.date), n: state.dur, s: state.selected.filter(id => !id.startsWith("custom")).join(","), bat: state.bat, link: state.link, minel: state.minel });
  history.replaceState(null, "", "#" + p.toString());
}

// ---------- series and metrics ----------
// One hourly pass per site over [start, end]. The Sun counts as in view when any part of its disc clears the skyline.
function series(site, start, end) {
  const key = [site.id, state.minel, start, end].join("|");
  if (cache.has(key)) return cache.get(key);
  const n = Math.floor((end - start) / HOUR) + 1;
  const sun = new Uint8Array(n), earth = new Uint8Array(n), ecl = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = skyAt(start + i * HOUR, site.frame);
    sun[i] = (k.sun.el + k.sunRadius > maskAt(site.mask, k.sun.az) && k.sunFraction > 0.001) ? 1 : 0;
    earth[i] = k.earth.el > Math.max(state.minel, maskAt(site.mask, k.earth.az)) ? 1 : 0;
    ecl[i] = k.eclipse ? 1 : 0;
  }
  const s = { start, end, n, sun, earth, ecl, ps: prefix(sun), pe: prefix(earth), pc: prefix(ecl), runS: runs(sun), runE: runs(earth) };
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, s); return s;
}
function prefix(a) { const p = new Int32Array(a.length + 1); for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i]; return p; }
// runs(a)[j] = length of the run of equal values to the right starting at j
function runs(a) { const r = new Int32Array(a.length); for (let j = a.length - 1; j >= 0; j--) r[j] = (j + 1 < a.length && a[j + 1] === a[j]) ? r[j + 1] + 1 : 1; return r; }
function longest(a, run, i0, w, val) {
  let best = 0;
  for (let j = i0; j < i0 + w; j++) { if (a[j] !== val) continue; if (j > i0 && a[j - 1] === val) continue; best = Math.max(best, Math.min(run[j], i0 + w - j)); }
  return best;
}
function windowMetrics(s, i0, w) {
  const sunH = s.ps[i0 + w] - s.ps[i0], earthH = s.pe[i0 + w] - s.pe[i0];
  return { sun: 100 * sunH / w, earth: 100 * earthH / w, dark: longest(s.sun, s.runS, i0, w, 0), gap: longest(s.earth, s.runE, i0, w, 0), ecl: s.pc[i0 + w] - s.pc[i0] };
}
function verdict(m) {
  const why = [];
  if (m.dark > state.bat) why.push(hours(m.dark) + " dark, battery holds " + hours(state.bat));
  if (m.earth < state.link) why.push("Earth link " + Math.round(m.earth) + "% (needs " + state.link + "%)");
  return why.length ? { ok: false, text: why.join("; ") } : { ok: true, text: "Works for this window" };
}
// The year of landing days on screen. It stays put while the bracket is dragged and only re-anchors when the date leaves it.
function ranges() {
  const w = state.dur * 24, first = state.eph.start + 2 * DAY, last = state.eph.end - 3 * DAY;
  let rs = state.rs;
  if (rs === undefined || state.date < rs || state.date > rs + (SPAN_DAYS - 1) * DAY) rs = state.date - 60 * DAY;
  rs = Math.max(first, Math.min(rs, last - (SPAN_DAYS + 1) * DAY - w * HOUR));
  state.rs = rs;
  const end = Math.min(rs + SPAN_DAYS * DAY + w * HOUR, last);
  return { start: rs, end, w, cols: Math.min(SPAN_DAYS, Math.floor((end - rs - w * HOUR) / DAY)) };
}

// ---------- render ----------
function render() {
  writeHash();
  const head = $("#headline");
  if (state.date < state.eph.start + 3 * DAY || state.date + state.dur * DAY > state.eph.end - 3 * DAY) {
    head.textContent = "That date is outside the ephemeris.";
    $("#subline").textContent = "Pick a landing date between March 2025 and October 2030.";
    return;
  }
  updateLedger(); renderSky(); scheduleMap();
  if (pole) { pole.setBase(state.date); pole.refresh(); }
}

// ---------- the ledger: one line of light per site ----------
let L = [], ledgerKey = "", axisCv = null;
function buildLedger(rows) {
  const host = $("#rows"); host.textContent = ""; L = [];
  guide = null;
  if (!rows.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "No site chosen. Open “Add or change sites” below and tick up to five."; host.append(p); axisCv = null; return; }
  const ax = document.createElement("div"); ax.className = "row axis"; ax.setAttribute("aria-hidden", "true");
  ax.innerHTML = '<div></div><div class="line"><canvas></canvas></div><div></div>'; host.append(ax); axisCv = $("canvas", ax);
  for (const site of rows) {
    const el = document.createElement("div"); el.className = "row"; el.setAttribute("role", "listitem");
    el.innerHTML = `<div class="name"><h3></h3><p></p><button class="rm" type="button">Remove</button></div>
      <div class="line"><canvas tabindex="0" role="img"></canvas></div>
      <div class="figs"><div class="fig"><b></b><span>Sun in view</span></div><div class="fig"><b></b><span>Longest dark</span></div><div class="fig"><b></b><span>Earth link</span></div><p class="verdict"></p></div>`;
    $("h3", el).textContent = site.name;
    $(".name p", el).textContent = (site.terrain ? "Real terrain skyline" : "Flat horizon") + ", " + site.lat.toFixed(2) + "°, " + site.lon.toFixed(2) + "°E";
    $(".rm", el).addEventListener("click", () => toggle(site.id, false));
    const cv = $("canvas", el);
    lineEvents(cv);
    host.append(el);
    L.push({ site, el, cv, figs: [...el.querySelectorAll(".fig b")], verdict: $(".verdict", el) });
  }
  guide = document.createElement("div"); guide.className = "guide"; guide.setAttribute("aria-hidden", "true"); guide.append(document.createElement("span")); host.append(guide);
}
// One thin line runs down every row at the day under the pointer, so sites can be read against each other.
let guide = null;
function moveGuide(cv, c) {
  if (!guide) return; const gm = cv._g, r = cv.getBoundingClientRect(), h = $("#rows").getBoundingClientRect();
  guide.style.transform = `translateX(${r.left - h.left + (c + 0.5) / gm.cols * r.width}px)`; guide.style.opacity = 1;
  $("span", guide).textContent = fmtDate(gm.start + c * DAY);
}
function updateLedger() {
  const rows = state.selected.map(id => state.byId.get(id)).filter(Boolean), key = rows.map(r => r.id).join(",");
  if (key !== ledgerKey) { ledgerKey = key; buildLedger(rows); }
  const { start, end, w, cols } = ranges(), head = $("#headline"), sub = $("#subline");
  if (axisCv) drawAxis(axisCv, start, cols);
  const out = [];
  for (const r of L) {
    const s = series(r.site, start, end), i0 = Math.round((state.date - start) / HOUR);
    const m = windowMetrics(s, i0, w), v = verdict(m); out.push({ site: r.site, m, v });
    r.figs[0].textContent = m.sun.toFixed(0) + "%"; r.figs[1].textContent = hours(m.dark); r.figs[2].textContent = m.earth.toFixed(0) + "%";
    r.verdict.textContent = v.ok ? "Works for this window." : v.text + "."; r.verdict.className = "verdict " + (v.ok ? "ok" : "no");
    const g = drawLine(r.cv, r.site, s, start, cols, w);
    r.cv._g = { start, cols, w, data: g.data, cw: g.cw, site: r.site };
    const viable = g.data.filter(c => c.v.ok).length;
    r.cv.setAttribute("aria-label", `${r.site.name}: ${viable} of ${cols} landing days in this year meet your limits. Landing ${fmtDate(state.date)}: sun ${m.sun.toFixed(0)}%, longest dark ${hours(m.dark)}, Earth link ${m.earth.toFixed(0)}%. Use the left and right arrow keys to move the landing day.`);
  }
  const ok = out.filter(o => o.v.ok);
  if (!rows.length) { head.textContent = "Choose a site to compare."; sub.textContent = "Open “Add or change sites” below."; return; }
  if (ok.length) {
    const best = ok.slice().sort((a, b) => a.m.dark - b.m.dark || b.m.sun - a.m.sun)[0];
    head.textContent = `${ok.length} of ${rows.length} sites work for ${state.dur} days from ${fmtDate(state.date)}.`;
    sub.textContent = `${best.site.name} goes without sun for the shortest time, ${hours(best.m.dark)}, with Earth in view ${best.m.earth.toFixed(0)}% of it. Drag a bracket to try another day.`;
  } else {
    head.textContent = `No site works for ${state.dur} days from ${fmtDate(state.date)}.`;
    sub.textContent = "Drag a bracket onto a stretch with ink along the bottom, or relax a limit.";
  }
}
function sizeCanvas(cv, H) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); return { g, W };
}
function drawAxis(cv, start, cols) {
  const { g, W } = sizeCanvas(cv, 22); if (!W) return;
  const cw = W / cols; g.font = "12px " + FONT; g.textBaseline = "top"; g.textAlign = "left"; g.fillStyle = col("muted");
  let lastX = -99;
  for (let c = 0; c < cols; c++) {
    const d = new Date(start + c * DAY);
    if (d.getUTCDate() !== 1 && c !== 0) continue;
    const x = c * cw, label = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) + (d.getUTCMonth() === 0 || c === 0 ? " " + String(d.getUTCFullYear()).slice(2) : "");
    g.fillRect(x, 14, 1, 8);
    if (x - lastX > 34) { g.fillText(label, x + 3, 0); lastX = x; }
  }
}
// Gold: the share of each day the Sun is up. Blue: the Earth link. Along the bottom, ink where a landing that day works and red where the dark outlasts the battery.
function drawLine(cv, site, s, start, cols, w) {
  const H = 84, { g, W } = sizeCanvas(cv, H), data = [];
  if (!W) return { data, cw: 1 };
  const cw = W / cols, bw = cw + 0.6;
  g.fillStyle = col("accent");
  for (let c = 0; c < cols; c++) {
    const m = windowMetrics(s, c * 24, w), v = verdict(m), d0 = c * 24, sunDay = (s.ps[d0 + 24] - s.ps[d0]) / 24, earthDay = (s.pe[d0 + 24] - s.pe[d0]) / 24;
    data.push({ m, v });
    const x = c * cw, h = sunDay * 46;
    g.fillStyle = col("accent"); g.fillRect(x, 48 - h, bw, h);
    g.fillStyle = col("earth"); g.globalAlpha = 0.18 + 0.82 * earthDay; g.fillRect(x, 54, bw, 6); g.globalAlpha = 1;
    if (v.ok) { g.fillStyle = col("ink"); g.fillRect(x, 68, bw, 9); }
    else if (m.dark > state.bat) { g.fillStyle = col("alert"); g.fillRect(x, 71, bw, 3); }
    else { g.fillStyle = col("rule"); g.fillRect(x, 71, bw, 3); }
  }
  g.fillStyle = col("ink"); g.fillRect(0, 48, W, 1);
  // the mission bracket
  const sel = (state.date - start) / DAY;
  if (sel >= -state.dur && sel < cols) {
    const x = sel * cw, bwid = Math.max(state.dur * cw, 8);
    g.fillStyle = rgba("ink", 0.07); g.fillRect(x, 0, bwid, H);
    g.fillStyle = col("ink"); g.fillRect(x, 0, 2, H); g.fillRect(x + bwid - 2, 0, 2, H); g.fillRect(x, 0, bwid, 2); g.fillRect(x, H - 2, bwid, 2);
  }
  return { data, cw };
}
function colAt(cv, ev) { const gm = cv._g; if (!gm) return null; const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(gm.cols - 1, Math.floor((ev.clientX - r.left) / r.width * gm.cols))); }
function setLanding(t) {
  const gm = L[0] && L[0].cv._g; if (!gm) return;
  const lo = gm.start, hi = gm.start + (gm.cols - 1) * DAY;
  state.date = Math.max(lo, Math.min(hi, t)); $("#date").value = iso(state.date); render();
}
function lineEvents(cv) {
  let drag = false;
  const move = ev => { const c = colAt(cv, ev); if (c === null) return; setLanding(cv._g.start + (c - Math.floor(state.dur / 2)) * DAY); };
  cv.addEventListener("pointerdown", ev => { drag = true; cv.setPointerCapture(ev.pointerId); move(ev); });
  cv.addEventListener("pointermove", ev => {
    if (drag) { move(ev); return; }
    const c = colAt(cv, ev), gm = cv._g; if (c === null) return;
    moveGuide(cv, c);
    const d = gm.data[c], n = $("#hoverNote");
    n.textContent = `${gm.site.name}, landing ${fmtDate(gm.start + c * DAY)}: sun ${d.m.sun.toFixed(0)}%, longest dark ${hours(d.m.dark)}, Earth link ${d.m.earth.toFixed(0)}%. ${d.v.ok ? "Works." : d.v.text + "."}`;
  });
  const end = () => { drag = false; };
  cv.addEventListener("pointerleave", () => { if (guide && !drag) guide.style.opacity = 0; });
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.addEventListener("keydown", ev => {
    const k = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 }[ev.key]; if (!k) return;
    ev.preventDefault(); setLanding(state.date + k * DAY);
  });
}

// ---------- Sky view ----------
function skySite() { return state.byId.get($("#skySite").value) || state.byId.get(state.selected[0]); }
function skyTime() { return state.date + state.tfrac * state.dur * DAY; }
let skyKey = "";
function renderSky() {
  const sel = $("#skySite"), key = state.selected.join(",");
  if (key !== skyKey) {
    const cur = sel.value; skyKey = key; sel.textContent = "";
    for (const id of state.selected) { const s = state.byId.get(id); if (s) { const o = document.createElement("option"); o.value = id; o.textContent = s.name; sel.append(o); } }
    if (state.selected.includes(cur)) sel.value = cur;
  }
  const site = skySite(); if (!site) return;
  const t = skyTime(); $("#skyClock").textContent = fmtDT(t);
  const k = skyAt(t, site.frame);
  drawPano(site, k);
  drawRibbon(site, t);
  fillReadout(site, k, t);
}
function drawPano(site, k) {
  const cv = $("#pano"), H = cv.clientWidth < 520 ? 260 : 340, { g, W } = sizeCanvas(cv, H); cv.style.height = H + "px"; if (!W) return;
  const polar = site.terrain, maxMask = site.mask ? Math.max(...site.mask) : 0;
  const ymax = polar ? Math.max(14, Math.ceil(maxMask + 4)) : 90, ymin = polar ? -6 : -10;
  const X = az => 6 + (az / 360) * (W - 12), Y = el => 10 + (1 - (el - ymin) / (ymax - ymin)) * (H - 40);
  g.fillStyle = col("space"); g.fillRect(0, 0, W, H);
  g.beginPath(); g.moveTo(X(0), Y(ymin) + 40);
  for (let a = 0; a <= 360; a++) g.lineTo(X(a), Y(site.mask ? maskAt(site.mask, a) : 0));
  g.lineTo(X(360), Y(ymin) + 40); g.closePath();
  const gr = g.createLinearGradient(0, Y(maxMask), 0, H); gr.addColorStop(0, rgba("space-ink", 0.24)); gr.addColorStop(1, rgba("space-ink", 0.05)); g.fillStyle = gr; g.fill();
  g.strokeStyle = rgba("space-ink", 0.85); g.lineWidth = 2; g.beginPath();
  for (let a = 0; a <= 360; a++) { const x = X(a), y = Y(site.mask ? maskAt(site.mask, a) : 0); a ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  g.font = "12px " + FONT; g.textAlign = "left"; g.textBaseline = "middle";
  const stepEl = polar ? (ymax > 20 ? 5 : 2) : 15;
  for (let e = Math.ceil(ymin / stepEl) * stepEl; e <= ymax; e += stepEl) { g.fillStyle = rgba("space-ink", 0.08); g.fillRect(0, Y(e), W, 1); g.fillStyle = col("space-muted"); g.fillText(e + "°", 8, Y(e) - 7); }
  g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = col("space-muted");
  [["N", 0], ["E", 90], ["S", 180], ["W", 270], ["N", 360]].forEach(([l, a]) => g.fillText(l, Math.min(W - 8, Math.max(8, X(a))), H - 22));
  const body = (b, name, radDeg, label) => {
    const x = X(b.az); if (!(b.el > ymin - 1 && b.el < ymax + 1)) return;
    const y = Y(b.el), r = Math.max(6, radDeg * (H - 40) / (ymax - ymin));
    const gl = g.createRadialGradient(x, y, 0, x, y, r * 4); gl.addColorStop(0, rgba(name, 0.5)); gl.addColorStop(1, rgba(name, 0));
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 4, 0, 7); g.fill();
    g.fillStyle = col(name); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = col("space-ink"); g.textAlign = x > W - 70 ? "right" : "left"; g.textBaseline = "middle"; g.fillText(label, x + (x > W - 70 ? -r - 8 : r + 8), y - 2);
  };
  body(k.earth, "earth-light", k.earthRadius, "Earth");
  body(k.sun, "accent", k.sunRadius, "Sun");
  g.fillStyle = col("space-muted"); g.textAlign = "right"; g.textBaseline = "top";
  g.fillText(polar ? "Skyline from NASA LOLA terrain, " + (site.custom ? "240 m" : "80 m") + ", antenna 2 m up" : "Flat horizon assumed: no terrain data north of 80°S", W - 8, 6);
}
function drawRibbon(site, t) {
  const cv = $("#ribbon"), H = 104, { g, W } = sizeCanvas(cv, H); if (!W) return;
  g.fillStyle = col("space"); g.fillRect(0, 0, W, H);
  const t0 = state.date, w = state.dur * 24, s = series(site, t0, t0 + (w + 2) * HOUR);
  const x0 = 6, pw = W - 12, step = pw / w;
  const row = (arr, y, on, label) => {
    for (let i = 0; i < w; i++) { g.fillStyle = arr[i] ? col(on) : col("space-2"); g.fillRect(x0 + i * step, y, Math.ceil(step) + 0.5, 24); }
    g.fillStyle = col("space-muted"); g.font = "12px " + FONT; g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText(label, x0 + 8, y - 3);
  };
  row(s.sun, 22, "accent", "Sun in view");
  row(s.earth, 64, "earth-light", "Earth link");
  for (let i = 0; i < w; i++) if (s.ecl[i]) { g.fillStyle = col("alert-light"); g.fillRect(x0 + i * step, 49, Math.ceil(step) + 0.5, 4); }
  g.fillStyle = col("space-muted"); g.textBaseline = "top"; g.textAlign = "left"; g.font = "12px " + FONT;
  const dstep = state.dur > 14 ? 5 : state.dur > 6 ? 2 : 1;
  for (let d = 0; d <= state.dur; d += dstep) { const x = x0 + d * 24 * step; g.fillRect(x, 90, 1, 5); g.fillText("day " + d, Math.min(W - 40, x + 3), 90); }
  const cx = x0 + ((t - t0) / HOUR) * step; g.fillStyle = col("space-ink"); g.fillRect(cx - 1, 2, 2, 86);
  cv.dataset.x0 = x0; cv.dataset.pw = pw;
}
function nextChange(site, kind, t) {
  // time (ms) until the state of Sun-in-view or Earth-link changes, found by stepping then bisecting
  const state0 = flag(site, kind, t);
  let a = t, b = t, n = 0;
  while (n++ < 24 * 60) { b = a + HOUR; if (flag(site, kind, b) !== state0) break; a = b; if (b > state.eph.end - 4 * DAY) return null; }
  if (n > 24 * 60) return null;
  for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (flag(site, kind, m) === state0) a = m; else b = m; }
  return { at: b, was: state0 };
}
function flag(site, kind, t) {
  const k = skyAt(t, site.frame);
  return kind === "sun" ? (k.sun.el + k.sunRadius > maskAt(site.mask, k.sun.az) && k.sunFraction > 0.001) : (k.earth.el > Math.max(state.minel, maskAt(site.mask, k.earth.az)));
}
function fillReadout(site, k, t) {
  const sunUp = flag(site, "sun", t), earthUp = flag(site, "earth", t);
  const ns = nextChange(site, "sun", t), ne = nextChange(site, "earth", t);
  const sm = maskAt(site.mask, k.sun.az);
  const when = (nx, upWord, downWord, was) => nx ? (was ? downWord : upWord) + " in " + hours((nx.at - t) / HOUR) : "no change within 60 days";
  const items = [
    ["Sun", `${k.sun.el.toFixed(2)}° up, bearing ${k.sun.az.toFixed(0)}°`, `${sunUp ? "Direct sunlight" : "In shadow"}. ${when(ns, "Sunrise", "Sunset", sunUp)}.`],
    ["Earth", `${k.earth.el.toFixed(2)}° up, bearing ${k.earth.az.toFixed(0)}°`, `${earthUp ? "Direct link possible" : "No direct link"}. ${when(ne, "Earthrise", "Earthset", earthUp)}.`],
    ["Skyline behind the Sun", `${sm.toFixed(2)}°`, sunUp ? `The Sun clears it by ${(k.sun.el + k.sunRadius - sm).toFixed(2)}°.` : `Sun ${(sm - k.sun.el - k.sunRadius).toFixed(2)}° below the skyline.`],
    ["Earth shades the Sun", k.eclipse === 2 ? "Total" : k.eclipse === 1 ? "Partial" : "No", k.eclipse ? `${(k.sunFraction * 100).toFixed(0)}% of the Sun is visible.` : "A lunar eclipse seen from the surface; solar power drops while it lasts."],
  ];
  const dl = $("#readout"); dl.textContent = "";  // four readings, one per column
  for (const [a, b, c] of items) { const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"), sm2 = document.createElement("small"); dt.textContent = a; dd.textContent = b; sm2.textContent = c; dd.append(sm2); d.append(dt, dd); dl.append(d); }
}

// ---------- terrain loading and the polar map ----------
async function loadTerrain() {
  if (state.terrain) return state.terrain;
  if (state.terrainLoading) return state.terrainLoading;
  const btn = $("#loadTerrain"); btn.disabled = true; btn.textContent = "Loading terrain…";
  state.terrainLoading = (async () => {
    try {
      const r = await fetch("data/dem240.bin.gz"); if (!r.ok) throw new Error("terrain file " + r.status);
      let buf;
      if (typeof DecompressionStream !== "undefined") buf = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      else throw new Error("this browser cannot unpack the terrain file");
      const n = 2533; state.terrain = new Terrain({ n, px: 240, unit: 2, data: unpack(new Int16Array(buf), n) });
      btn.textContent = "Terrain loaded"; return state.terrain;
    } catch (e) { btn.disabled = false; btn.textContent = "Load terrain (5 MB)"; $("#mapNote").textContent = "Terrain failed to load: " + e.message; state.terrainLoading = null; throw e; }
  })();
  return state.terrainLoading;
}
async function addCustom(lat, lon, name) {
  lat = +lat; lon = ((+lon % 360) + 360) % 360;
  const help = $("#chelp");
  if (!(lat >= -90 && lat <= 90) || isNaN(lon)) { help.textContent = "Latitude must be between -90 and 90, longitude a number."; return; }
  const id = "custom-" + lat.toFixed(3) + "_" + lon.toFixed(3);
  if (state.byId.has(id)) { toggle(id, true); return; }
  let mask = null, terrain = false;
  if (lat <= -80.2) {
    help.textContent = "Loading NASA terrain for your site…";
    try { const T = await loadTerrain(); const m = T.horizon(lat, lon, { mast: 2, maxKm: 250 }); if (m) { mask = m; terrain = true; } } catch (e) { /* fall through to flat */ }
  }
  const s = { id, name: name || `Custom ${lat.toFixed(2)}°, ${lon.toFixed(2)}°E`, lat, lon, group: "Yours", note: "", mask, terrain, custom: true };
  addSite(s); buildSiteList(); toggle(id, true);
  help.textContent = terrain ? "Added. Skyline computed from NASA terrain (240 m)." : (lat <= -80.2 ? "Added with a flat horizon: terrain could not be loaded." : "Added with a flat horizon: there is no terrain data north of 80°S in this tool.");
}
function sunVec(t) { const v = vectorsAt(t); return { sun: v.subarray(0, 3), earth: v.subarray(3, 6) }; }
// ---------- survival map: precomputed skylines + the ephemeris, for every 1 km point within 100 km of the pole ----------
const SV = { N: 200, PX: 1000, NA: 180, OFF: -8, Q: 0.25 };
async function loadGz(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status);
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot unpack the data file");
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
async function ensureSurvivalData() {
  if (state.sky && state.relief) return;
  $("#mapNote").textContent = "Loading skylines for 40,000 points near the pole…";
  const [sky, relief] = await Promise.all([state.sky || loadGz("data/skylines.bin.gz"), state.relief || new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("relief image")); im.src = "data/relief.png"; })]);
  state.sky = sky; state.relief = relief;
  // local frames once
  const N = SV.N, R = R_MOON * 1000, fr = new Float32Array(N * N * 9);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + .5 - N / 2) * SV.PX, y = (N / 2 - j - .5) * SV.PX, q = (x * x + y * y) / (4 * R * R), pz = (q - 1) / (q + 1), k = 1 / (R * (q + 1));
    const la = Math.asin(pz), lo = Math.atan2(x * k, y * k), f = siteFrame(la / DEG, lo / DEG), o = (j * N + i) * 9;
    fr.set([...f.up, ...f.east, ...f.north], o);
  }
  state.frames = fr;
}
function surviveField() {
  const key = [state.date, state.dur, state.minel, state.bat, state.link].join("|");
  if (state.field && state.field.key === key) return state.field;
  const N = SV.N, steps = Math.floor(state.dur * 24 / 3) + 1, STEP_H = 3, mask = state.sky, fr = state.frames, Rm = R_MOON;
  const vs = [], limb = new Float32Array(steps), frac = new Float32Array(steps), pole = siteFrame(-89.5, 0);
  for (let k = 0; k < steps; k++) {
    const t = state.date + k * STEP_H * HOUR; vs.push(vectorsAt(t));
    const sk = skyAt(t, pole); limb[k] = sk.sunRadius; frac[k] = sk.sunFraction;   // Earth shading is the same across a 200 km patch
  }
  const sun = new Float32Array(N * N), earth = new Float32Array(N * N), dark = new Float32Array(N * N), ok = new Uint8Array(N * N);
  const dec = (cell, az) => { const a = az / 2, a0 = Math.floor(a) % 180, a1 = (a0 + 1) % 180, f = a - Math.floor(a); return (mask[cell + a0] * (1 - f) + mask[cell + a1] * f) * SV.Q + SV.OFF; };
  for (let p = 0; p < N * N; p++) {
    const o = p * 9, ux = fr[o], uy = fr[o + 1], uz = fr[o + 2], ex = fr[o + 3], ey = fr[o + 4], ez = fr[o + 5], nx = fr[o + 6], ny = fr[o + 7], nz = fr[o + 8], cell = p * SV.NA;
    let sl = 0, el = 0, run = 0, best = 0;
    for (let k = 0; k < steps; k++) {
      const v = vs[k];
      let rx = v[0] - Rm * ux, ry = v[1] - Rm * uy, rz = v[2] - Rm * uz, rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
      let az = Math.atan2(rx * ex + ry * ey + rz * ez, rx * nx + ry * ny + rz * nz) / DEG; if (az < 0) az += 360;
      const sEl = Math.asin((rx * ux + ry * uy + rz * uz) / rn) / DEG;
      const lit = sEl + limb[k] > dec(cell, az) && frac[k] > 0.001;
      rx = v[3] - Rm * ux; ry = v[4] - Rm * uy; rz = v[5] - Rm * uz; rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
      az = Math.atan2(rx * ex + ry * ey + rz * ez, rx * nx + ry * ny + rz * nz) / DEG; if (az < 0) az += 360;
      const eEl = Math.asin((rx * ux + ry * uy + rz * uz) / rn) / DEG;
      if (eEl > Math.max(state.minel, dec(cell, az))) el++;
      if (lit) { sl++; run = 0; } else { run++; if (run > best) best = run; }
    }
    sun[p] = 100 * sl / steps; earth[p] = 100 * el / steps; dark[p] = best * STEP_H;
    ok[p] = (dark[p] <= state.bat && earth[p] >= state.link) ? 1 : 0;
  }
  return (state.field = { key, sun, earth, dark, ok, steps });
}
// Slip margin: for every point, try every landing day in the next SLIP_SPAN days and keep the longest unbroken run of days that work.
// One pass over the whole span per point; each landing day is then a window read off prefix sums.
const SLIP_SPAN = 90;
async function slipField() {
  const key = [state.date, state.dur, state.minel, state.bat, state.link].join("|");
  if (state.slip && state.slip.key === key) return state.slip;
  const N = SV.N, PER = 8, STEP_H = 3, W = state.dur * PER, steps = (SLIP_SPAN + state.dur) * PER + 1, mask = state.sky, fr = state.frames, Rm = R_MOON;
  const vs = [], limb = new Float32Array(steps), frac = new Float32Array(steps), pole = siteFrame(-89.5, 0);
  for (let k = 0; k < steps; k++) { const t = state.date + k * STEP_H * HOUR; vs.push(vectorsAt(t)); const sk = skyAt(t, pole); limb[k] = sk.sunRadius; frac[k] = sk.sunFraction; }
  const dec = (cell, az) => { const a = az / 2, a0 = Math.floor(a) % 180, a1 = (a0 + 1) % 180, f = a - Math.floor(a); return (mask[cell + a0] * (1 - f) + mask[cell + a1] * f) * SV.Q + SV.OFF; };
  const run = new Uint8Array(N * N), days = new Uint8Array(N * N), sA = new Uint8Array(steps), eA = new Uint8Array(steps);
  const ps = new Int32Array(steps + 1), pe = new Int32Array(steps + 1), rS = new Int32Array(steps);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const p = j * N + i, o = p * 9, ux = fr[o], uy = fr[o + 1], uz = fr[o + 2], ex = fr[o + 3], ey = fr[o + 4], ez = fr[o + 5], nx = fr[o + 6], ny = fr[o + 7], nz = fr[o + 8], cell = p * SV.NA;
      for (let k = 0; k < steps; k++) {
        const v = vs[k];
        let rx = v[0] - Rm * ux, ry = v[1] - Rm * uy, rz = v[2] - Rm * uz, rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
        let az = Math.atan2(rx * ex + ry * ey + rz * ez, rx * nx + ry * ny + rz * nz) / DEG; if (az < 0) az += 360;
        const sEl = Math.asin((rx * ux + ry * uy + rz * uz) / rn) / DEG;
        sA[k] = (sEl + limb[k] > dec(cell, az) && frac[k] > 0.001) ? 1 : 0;
        rx = v[3] - Rm * ux; ry = v[4] - Rm * uy; rz = v[5] - Rm * uz; rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
        az = Math.atan2(rx * ex + ry * ey + rz * ez, rx * nx + ry * ny + rz * nz) / DEG; if (az < 0) az += 360;
        const eEl = Math.asin((rx * ux + ry * uy + rz * uz) / rn) / DEG;
        eA[k] = eEl > Math.max(state.minel, dec(cell, az)) ? 1 : 0;
      }
      for (let k = 0; k < steps; k++) { ps[k + 1] = ps[k] + sA[k]; pe[k + 1] = pe[k] + eA[k]; }
      for (let k = steps - 1; k >= 0; k--) rS[k] = (k + 1 < steps && sA[k + 1] === sA[k]) ? rS[k + 1] + 1 : 1;
      let best = 0, cur = 0, n = 0;
      for (let d = 0; d < SLIP_SPAN; d++) {
        const i0 = d * PER, earthPct = 100 * (pe[i0 + W] - pe[i0]) / W, dark = longest(sA, rS, i0, W, 0) * STEP_H;
        if (dark <= state.bat && earthPct >= state.link) { cur++; n++; if (cur > best) best = cur; } else cur = 0;
      }
      run[p] = best; days[p] = n;
    }
    if (j % 20 === 19) await new Promise(r => setTimeout(r, 0));
  }
  return (state.slip = { key, run, days });
}
async function renderSurvival(layer) {
  const cv = $("#map"), note = $("#mapNote"), g = cv.getContext("2d");
  try { await ensureSurvivalData(); } catch (e) { note.textContent = "Could not load the polar data: " + e.message; return; }
  let S = null;
  if (layer === "slip") { note.textContent = "Trying every landing day for 40,000 points…"; S = await slipField(); }
  const F = surviveField(), N = SV.N, img = new ImageData(N, N), space = rgb("space"), gold = rgb("accent"), blue = rgb("earth-light"), red = rgb("alert-light");
  let nOk = 0, bestP = -1;
  for (let p = 0; p < N * N; p++) {
    const o = p * 4; let c, a;
    if (layer === "slip") {
      const r = S.run[p];
      if (r > 0) { nOk++; c = mix(mix(space, gold, 0.35), gold, Math.min(1, r / 30)); a = 225; if (bestP < 0 || r > S.run[bestP] || (r === S.run[bestP] && F.dark[p] < F.dark[bestP])) bestP = p; } else { c = space; a = 120; }
    }
    else if (layer === "survive") { if (F.ok[p]) { nOk++; c = mix(mix(space, gold, 0.5), gold, F.sun[p] / 100); a = 225; if (bestP < 0 || F.dark[p] < F.dark[bestP] || (F.dark[p] === F.dark[bestP] && F.sun[p] > F.sun[bestP])) bestP = p; } else { c = space; a = 120; } }
    else if (layer === "sunwin") { c = mix(space, gold, F.sun[p] / 100); a = 205; }
    else if (layer === "earthwin") { c = mix(space, blue, F.earth[p] / 100); a = 205; }
    else { const t = Math.min(1, F.dark[p] / Math.max(24, state.dur * 24)); c = mix(gold, red, t); a = 60 + 160 * t; }
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = a;
  }
  g.imageSmoothingEnabled = true; g.drawImage(state.relief, 0, 0, cv.width, cv.height);
  const off = document.createElement("canvas"); off.width = N; off.height = N; off.getContext("2d").putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false; g.drawImage(off, 0, 0, cv.width, cv.height); g.imageSmoothingEnabled = true;
  const span = 100000, toPx = (lat, lon) => { const la = lat * DEG, lo = lon * DEG, cl = Math.cos(la), [x, y] = Terrain.project([cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)]); return [(x / span + 1) / 2 * cv.width, (1 - y / span) / 2 * cv.height]; };
  g.strokeStyle = rgba("space-ink", 0.25); g.lineWidth = 1; g.font = "12px " + FONT; g.textBaseline = "middle"; g.textAlign = "left"; g.fillStyle = rgba("space-ink", 0.7);
  const [cx, cy] = toPx(-90, 0);
  for (const lat of [-89, -88, -87, -86]) { const [ex] = toPx(lat, 0), rad = Math.abs(ex - cx); g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.stroke(); g.fillText(Math.abs(lat) + "°S", cx + rad * .707 + 3, cy + rad * .707 + 10); }
  for (const id of state.selected) {
    const s = state.byId.get(id); if (!s || s.lat > -80) continue; const [x, y] = toPx(s.lat, s.lon);
    if (x < 6 || y < 6 || x > cv.width - 6 || y > cv.height - 6) continue;
    g.fillStyle = col("space-ink"); g.strokeStyle = col("space"); g.lineWidth = 3; g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.stroke(); g.fill();
    g.strokeStyle = rgba("space", 0.9); g.strokeText(s.name, x + 9, y); g.fillStyle = col("space-ink"); g.fillText(s.name, x + 9, y);
  }
  if ((layer === "survive" || layer === "slip") && bestP >= 0) {
    const i = bestP % N, j = Math.floor(bestP / N), px = (i + .5) / N * cv.width, py = (j + .5) / N * cv.height;
    g.strokeStyle = col("space"); g.lineWidth = 5; g.beginPath(); g.arc(px, py, 10, 0, 7); g.stroke();
    g.strokeStyle = col("space-ink"); g.lineWidth = 2.5; g.beginPath(); g.arc(px, py, 10, 0, 7); g.stroke();
    state.best = cellLatLon(i, j);
  }
  state.mapLayer = layer;
  const area = N * N, pct = (100 * nOk / area).toFixed(1);
  if (layer === "slip") {
    note.textContent = "";
    const wide = S.run.reduce((n, r) => n + (r >= 14 ? 1 : 0), 0), exact = F.ok.reduce((n, v) => n + v, 0);
    setFigs(bestP >= 0 ? [["days a landing can slip at the best point", String(S.run[bestP]), true], ["km² work on the chosen day", exact.toLocaleString()], ["km² survive a two-week slip", wide.toLocaleString()]] : null);
    if (bestP >= 0) {
      const b = document.createElement("b"); b.textContent = `${S.run[bestP]} landing days in a row`;
      note.append(b, ` work at the best point (ringed, ${state.best.lat.toFixed(2)}°, ${state.best.lon.toFixed(2)}°E), so a ${state.dur}-day mission launched from ${fmtDate(state.date)} can slip that long and still meet your limits. Only ${exact.toLocaleString()} km² work on ${fmtDate(state.date)} itself, and ${wide.toLocaleString()} km² can absorb a slip of two weeks or more.`);
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Add it as a site";
      btn.addEventListener("click", () => addCustom(state.best.lat.toFixed(3), state.best.lon.toFixed(3), `Slip-tolerant point ${state.best.lat.toFixed(2)}°, ${state.best.lon.toFixed(2)}°E`));
      note.append(btn);
    } else note.textContent = `No point in this patch works on any landing day in the 90 days from ${fmtDate(state.date)} with those limits. Loosen the battery or link limit.`;
    state.slipNote = true;
  } else if (layer === "survive") {
    note.textContent = "";
    setFigs(nOk ? [["km² survive the whole mission", nOk.toLocaleString(), true], ["share of this patch", pct + "%"], ["hours of dark at the best point", String(F.dark[bestP])]] : null);
    if (nOk) {
      const b = document.createElement("b"); b.textContent = `${nOk.toLocaleString()} km² (${pct}%)`;
      note.append(b, ` of this 200 km patch survives ${state.dur} days from ${fmtDate(state.date)} with a ${state.bat} h battery and a ${state.link}% link. Best point (ringed): ${state.best.lat.toFixed(2)}°, ${state.best.lon.toFixed(2)}°E, sun ${F.sun[bestP].toFixed(0)}%, longest dark ${hours(F.dark[bestP])}, Earth ${F.earth[bestP].toFixed(0)}%.`);
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Add it as a site";
      btn.addEventListener("click", () => addCustom(state.best.lat.toFixed(3), state.best.lon.toFixed(3), `Best point ${state.best.lat.toFixed(2)}°, ${state.best.lon.toFixed(2)}°E`));
      note.append(btn);
    } else {
      const b = document.createElement("b"); b.textContent = "No point";
      note.append(b, ` in this 200 km patch survives ${state.dur} days from ${fmtDate(state.date)} with those limits. Try another date, a bigger battery, or a lower link requirement.`);
    }
  } else { setFigs(null); note.textContent = "Each cell is a 1 km grid point with its own true skyline. Hover for numbers; click to add a spot as a site."; }
}
function setFigs(list) {
  const dl = $("#mapFigs"); dl.textContent = ""; dl.hidden = !list; if (!list) return;
  for (const [label, val, gold] of list) { const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"); if (gold) d.className = "gold"; dt.textContent = label; dd.textContent = val; d.append(dt, dd); dl.append(d); }
}
function cellLatLon(i, j) {
  const N = SV.N, R = R_MOON * 1000, x = (i + .5 - N / 2) * SV.PX, y = (N / 2 - j - .5) * SV.PX, q = (x * x + y * y) / (4 * R * R), pz = (q - 1) / (q + 1), k = 1 / (R * (q + 1));
  return { lat: Math.asin(pz) / DEG, lon: ((Math.atan2(x * k, y * k) / DEG) + 360) % 360 };
}

let mapBusy = false, mapPending = false, mapTimer = 0, mapSeen = false;
function scheduleMap(immediate) { if (!mapSeen) return; clearTimeout(mapTimer); mapTimer = setTimeout(renderMap, immediate ? 0 : 140); }
function renderMap() {
  const cv = $("#map"), note = $("#mapNote");
  const layer = $("#layer").value, now = layer === "sunnow" || layer === "earthnow";
  $("#spanLabel").hidden = !now; $("#loadTerrain").hidden = !now;
  if (!now) {
    if (mapBusy) { mapPending = true; return; }
    mapBusy = true;
    renderSurvival(layer).finally(() => { mapBusy = false; if (mapPending) { mapPending = false; renderMap(); } });
    return;
  }
  if (!state.terrain) {
    const g = cv.getContext("2d"); g.fillStyle = col("space"); g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = col("space-muted"); g.font = "16px " + FONT; g.textAlign = "center"; g.fillText("Press “Load terrain” to draw the polar region.", cv.width / 2, cv.height / 2);
    note.textContent = "This layer draws the lit ground at the Sky moment, " + fmtDT(skyTime()) + ". It needs the 5 MB terrain file."; return;
  }
  note.textContent = "Lit ground at the Sky moment, " + fmtDT(skyTime()) + ". Move the Sky slider to watch the light cross the terrain.";
  if (mapBusy) return; mapBusy = true;
  requestAnimationFrame(() => { try { drawMap(); } finally { mapBusy = false; } });
}
function drawMap() {
  const T = state.terrain, cv = $("#map"), span = +$("#span").value * 1000, layer = $("#layer").value === "earthnow" ? "earth" : "sun";
  const N = state.playing ? 200 : 320, img = new ImageData(N, N), per = 2 * span / N, t = skyTime(), vs = sunVec(t);
  const target = layer === "sun" ? vs.sun : vs.earth, limb = layer === "sun" ? Math.asin(R_SUN / Math.hypot(...vs.sun)) / DEG : 0;
  const R = R_MOON * 1000, BASE = 1737400, sp = rgb("space"), litC = layer === "sun" ? rgb("accent") : rgb("earth-light");
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + .5 - N / 2) * per, y = (N / 2 - j - .5) * per, o = (j * N + i) * 4;
    const h = T.heightAtXY(x, y);
    if (Number.isNaN(h)) { img.data[o] = sp[0]; img.data[o + 1] = sp[1]; img.data[o + 2] = sp[2]; img.data[o + 3] = 255; continue; }
    // hillshade (light from the upper left, relief exaggerated)
    const hx = T.heightAtXY(x + 240, y), hxm = T.heightAtXY(x - 240, y), hy = T.heightAtXY(x, y + 240), hym = T.heightAtXY(x, y - 240);
    const dzdx = ((hx - hxm) / 480) || 0, dzdy = ((hy - hym) / 480) || 0;
    let sh = 0.5 + 2.2 * (-dzdx * 0.7 + dzdy * 0.7) / Math.sqrt(1 + 4 * (dzdx * dzdx + dzdy * dzdy)); sh = Math.max(0.08, Math.min(1, sh));
    // local frame from map position
    const q = (x * x + y * y) / (4 * R * R), pz = (q - 1) / (q + 1), k = 1 / (R * (q + 1)), p = [y * k, x * k, pz];
    const la = Math.asin(pz), lo = Math.atan2(p[1], p[0]), cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    const up = [cl * co, cl * so, sl], east = [-so, co, 0], north = [-sl * co, -sl * so, cl];
    const r0 = BASE + h;
    const rel = [target[0] - R * up[0], target[1] - R * up[1], target[2] - R * up[2]], rn = Math.hypot(...rel);
    const el = Math.asin((rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2]) / rn) / DEG;
    const az = Math.atan2(rel[0] * east[0] + rel[1] * east[1] + rel[2] * east[2], rel[0] * north[0] + rel[1] * north[1] + rel[2] * north[2]);
    let lit = el + limb > 0 && (layer === "sun" || el > state.minel);
    if (lit) {
      const ca = Math.cos(az), sa = Math.sin(az), dir = [ca * north[0] + sa * east[0], ca * north[1] + sa * east[1], ca * north[2] + sa * east[2]];
      const tgt = Math.tan((el + limb) * DEG); let s = 120;
      while (s < 200000) {
        const th = s / R, ct = Math.cos(th), st = Math.sin(th);
        const pp = [ct * up[0] + st * dir[0], ct * up[1] + st * dir[1], ct * up[2] + st * dir[2]], kk = 2 * R / (1 - pp[2]);
        const hh = T.heightAtXY(kk * pp[1], kk * pp[0]); if (Number.isNaN(hh)) break;
        const r1 = BASE + hh; if ((r1 * ct - r0) / (r1 * st) > tgt) { lit = false; break; }
        s += s < 12000 ? 120 : s < 60000 ? 300 : 700;
      }
    }
    const b = 0.35 + 0.65 * sh;
    if (lit) { img.data[o] = litC[0] * b; img.data[o + 1] = litC[1] * b; img.data[o + 2] = litC[2] * b; }
    else { img.data[o] = sp[0] + 30 * b; img.data[o + 1] = sp[1] + 32 * b; img.data[o + 2] = sp[2] + 40 * b; }
    img.data[o + 3] = 255;
  }
  const off = document.createElement("canvas"); off.width = N; off.height = N; off.getContext("2d").putImageData(img, 0, 0);
  const g = cv.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(off, 0, 0, cv.width, cv.height);
  // graticule and sites
  const toPx = (lat, lon) => { const la = lat * DEG, lo = lon * DEG, cl = Math.cos(la), [x, y] = Terrain.project([cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)]); return [(x / span + 1) / 2 * cv.width, (1 - y / span) / 2 * cv.height]; };
  g.strokeStyle = rgba("space-ink", 0.2); g.fillStyle = rgba("space-ink", 0.55); g.lineWidth = 1; g.font = "12px " + FONT; g.textAlign = "left"; g.textBaseline = "middle";
  for (const lat of [-89, -88, -87, -86, -85, -84, -83, -82, -81, -80]) {
    const [cx, cy] = toPx(-90, 0), [ex] = toPx(lat, 0), rad = Math.hypot(ex - cx, 0); if (rad > cv.width * .72) continue;
    g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.stroke(); if (rad < cv.width / 2 - 20) g.fillText(Math.abs(lat) + "°S", cx + rad * .707 + 3, cy - rad * .707);
  }
  for (const id of state.selected) {
    const s = state.byId.get(id); if (!s || s.lat > -80) continue; const [x, y] = toPx(s.lat, s.lon);
    if (x < 0 || y < 0 || x > cv.width || y > cv.height) continue;
    g.fillStyle = col("space-ink"); g.strokeStyle = col("space"); g.lineWidth = 3; g.beginPath(); g.arc(x, y, 5, 0, 7); g.stroke(); g.fill();
    g.lineWidth = 3; g.strokeStyle = rgba("space", 0.85); g.strokeText(s.name, x + 9, y); g.fillStyle = col("space-ink"); g.fillText(s.name, x + 9, y);
  }
  g.fillStyle = rgba("space-ink", 0.7); g.textAlign = "left"; g.fillText("0° longitude is up. South pole at the centre.", 10, cv.height - 12);
}
function mapHover(ev) {
  const layer = $("#layer").value; if (layer === "sunnow" || layer === "earthnow" || !state.field) return;
  const cv = $("#map"), r = cv.getBoundingClientRect(), N = SV.N, i = Math.floor((ev.clientX - r.left) / r.width * N), j = Math.floor((ev.clientY - r.top) / r.height * N);
  if (i < 0 || j < 0 || i >= N || j >= N) return; const p = j * N + i, F = state.field, ll = cellLatLon(i, j);
  const sl = layer === "slip" && state.slip ? `slip margin ${state.slip.run[p]} days, ` : "";
  cv.title = `${ll.lat.toFixed(2)}°, ${ll.lon.toFixed(1)}°E: ${sl}Sun ${F.sun[p].toFixed(0)}%, longest dark ${hours(F.dark[p])}, Earth ${F.earth[p].toFixed(0)}%, ${F.ok[p] ? "survives" : "does not survive"}`;
}
function mapClick(ev) {
  const live = $("#layer").value === "sunnow" || $("#layer").value === "earthnow";
  if (live && !state.terrain) return;
  const cv = $("#map"), r = cv.getBoundingClientRect(), span = live ? +$("#span").value * 1000 : 100000;
  const x = ((ev.clientX - r.left) / r.width * 2 - 1) * span, y = (1 - (ev.clientY - r.top) / r.height * 2) * span, R = R_MOON * 1000;
  const q = (x * x + y * y) / (4 * R * R), pz = (q - 1) / (q + 1), k = 1 / (R * (q + 1));
  const lat = Math.asin(pz) / DEG, lon = ((Math.atan2(x * k, y * k) / DEG) + 360) % 360;
  addCustom(lat.toFixed(3), lon.toFixed(3), `Map point ${lat.toFixed(2)}°, ${lon.toFixed(2)}°E`);
}

// ---------- site list and wiring ----------
function buildSiteList() {
  const ul = $("#siteList"); ul.textContent = "";
  const groups = new Map(); for (const s of state.sites) { const g = s.group.startsWith("Landed") || s.group === "Attempted 2023" ? "Past landings" : s.group.startsWith("Artemis") || s.group.startsWith("CLPS") ? "South pole candidates" : s.group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  for (const g of ["Yours", "South pole candidates", "Polar crater", "Past landings"]) {
    if (!groups.has(g)) continue;
    const h = document.createElement("li"); h.className = "grp"; h.textContent = g; ul.append(h);
    for (const s of groups.get(g)) {
      const li = document.createElement("li"), id = "chk-" + s.id, cb = document.createElement("input");
      cb.type = "checkbox"; cb.id = id; cb.checked = state.selected.includes(s.id); cb.addEventListener("change", () => toggle(s.id, cb.checked));
      const lab = document.createElement("label"); lab.htmlFor = id; lab.innerHTML = '<span class="nm"></span><span class="g"></span>';
      $(".nm", lab).textContent = s.name; $(".g", lab).textContent = s.note || (s.lat.toFixed(2) + "°, " + s.lon.toFixed(2) + "°E");
      li.append(cb, lab); ul.append(li);
    }
  }
  $("#count").textContent = state.selected.length + " of " + MAX_SITES + " chosen";
}
function toggle(id, on) {
  const i = state.selected.indexOf(id);
  if (on && i < 0) { if (state.selected.length >= MAX_SITES) state.selected.shift(); state.selected.push(id); }
  if (!on && i >= 0) state.selected.splice(i, 1);
  buildSiteList(); render();
}
function syncInputs() {
  $("#date").value = iso(state.date); $("#dur").value = state.dur; $("#bat").value = state.bat; $("#link").value = state.link; $("#minel").value = state.minel;
  labels();
}
function labels() {
  $("#durOut").textContent = state.dur + " days"; $("#batOut").textContent = state.bat + " h"; $("#linkOut").textContent = state.link + "%"; $("#elOut").textContent = state.minel + "°";
}
let raf = 0, lastTs = 0;
function stop() { state.playing = false; cancelAnimationFrame(raf); $("#play").textContent = "Play"; }
function skyMoved() { renderSky(); scheduleMap(); }
function tick(ts) {
  if (!state.playing) return;
  const dt = (ts - lastTs) / 1000; lastTs = ts;
  state.tfrac += dt * 8 * HOUR / (state.dur * DAY);   // 8 simulated hours per real second
  if (state.tfrac >= 1) state.tfrac = 0;
  $("#tscrub").value = Math.round(state.tfrac * 1000); skyMoved(); raf = requestAnimationFrame(tick);
}
function wire() {
  const upd = () => { state.date = Date.parse($("#date").value + "T00:00:00Z") || state.date; state.dur = +$("#dur").value; state.bat = +$("#bat").value; state.link = +$("#link").value; state.minel = +$("#minel").value; labels(); render(); };
  for (const id of ["date", "dur", "bat", "link", "minel"]) $("#" + id).addEventListener("input", upd);
  $("#skySite").addEventListener("change", skyMoved);
  $("#tscrub").addEventListener("input", () => { state.tfrac = $("#tscrub").value / 1000; skyMoved(); });
  $("#play").addEventListener("click", () => { if (state.playing) return stop(); state.playing = true; lastTs = performance.now(); $("#play").textContent = "Pause"; raf = requestAnimationFrame(tick); });
  $("#ribbon").addEventListener("click", ev => { const cv = ev.currentTarget, r = cv.getBoundingClientRect(), x0 = +cv.dataset.x0, pw = +cv.dataset.pw; state.tfrac = Math.max(0, Math.min(1, (ev.clientX - r.left - x0) / pw)); $("#tscrub").value = Math.round(state.tfrac * 1000); skyMoved(); });
  $("#custom").addEventListener("submit", ev => { ev.preventDefault(); addCustom($("#clat").value, $("#clon").value); });
  $("#loadTerrain").addEventListener("click", async () => { try { await loadTerrain(); scheduleMap(true); } catch (e) { /* message shown in the map note */ } });
  $("#layer").addEventListener("change", () => scheduleMap(true)); $("#span").addEventListener("change", () => scheduleMap(true));
  $("#map").addEventListener("click", mapClick); $("#map").addEventListener("pointermove", mapHover);
  // the polar data is 8 MB, so it loads when the map section is near the screen
  const sec = $("#above");
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((en, ob) => { if (en.some(e => e.isIntersecting)) { mapSeen = true; ob.disconnect(); scheduleMap(true); } }, { rootMargin: "1500px 0px" }).observe(sec);
  } else { mapSeen = true; scheduleMap(true); }
  let rz = 0; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 120); });
}
boot();
