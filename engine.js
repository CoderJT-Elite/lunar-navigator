// Lunar Landing Site Navigator: calculation engine (no dependencies; browser and Node).
// Inputs are NASA/JPL Horizons (DE441) Sun and Earth vectors, hourly, 2025-2030, rebuilt in the Moon's
// Mean-Earth frame (tools/build_ephem.py). Sun and Earth positions at any site are computed from them.
// Every function here is covered by tools/validate.mjs against live Horizons output.

export const R_MOON = 1737.4;          // km, the sphere Horizons and LOLA both use
export const R_SUN = 695700.0;         // km
export const R_EARTH = 6378.137;       // km (equatorial; the atmosphere is ignored)
export const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
export const STEP_MS = 3600000;
const DEG = Math.PI / 180;

let EPH = null; // Float32Array, 6 floats per hour: sun xyz, earth xyz (km, Moon-centred, ME frame)
export function setEphemeris(buf) { EPH = new Float32Array(buf); }
export function ephemerisRange() {
  const n = EPH.length / 6;
  return { start: EPOCH_MS, end: EPOCH_MS + (n - 1) * STEP_MS };
}

// Catmull-Rom cubic through four hourly samples; rotation of the frame is slow (0.55 deg/hour), so this is tight.
function cr(p0, p1, p2, p3, f) {
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}
export function vectorsAt(tMs) {
  const n = EPH.length / 6;
  const h = (tMs - EPOCH_MS) / STEP_MS;
  if (h < 1 || h > n - 3) throw new RangeError("Date outside the ephemeris (2025-01-01 to 2030-12-31).");
  const i = Math.floor(h), f = h - i;
  const out = new Float64Array(6);
  for (let k = 0; k < 6; k++) {
    out[k] = cr(EPH[(i - 1) * 6 + k], EPH[i * 6 + k], EPH[(i + 1) * 6 + k], EPH[(i + 2) * 6 + k], f);
  }
  return out;
}

// Local frame at a site (planetocentric latitude, east longitude), in ME axes: +X toward mean Earth, +Y east, +Z north pole.
export function siteFrame(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  const cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
  return {
    up: [cl * co, cl * so, sl],
    east: [-so, co, 0],
    north: [-sl * co, -sl * so, cl],
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Topocentric azimuth (deg, from north through east), elevation (deg) and range (km) of a Moon-centred vector.
export function azel(v, fr) {
  const r = [v[0] - R_MOON * fr.up[0], v[1] - R_MOON * fr.up[1], v[2] - R_MOON * fr.up[2]];
  const rng = Math.hypot(r[0], r[1], r[2]);
  const e = dot(r, fr.east), n = dot(r, fr.north), u = dot(r, fr.up);
  let az = Math.atan2(e, n) / DEG; if (az < 0) az += 360;
  return { az, el: Math.asin(u / rng) / DEG, rng };
}

// Sun and Earth as seen from a site, plus whether the Earth is covering the Sun (a lunar eclipse seen from the Moon).
export function skyAt(tMs, fr) {
  const v = vectorsAt(tMs);
  const s = azel(v.subarray(0, 3), fr), e = azel(v.subarray(3, 6), fr);
  // angular separation of the Sun and Earth centres as seen from the site
  const rs = vSub(v.subarray(0, 3), fr), re = vSub(v.subarray(3, 6), fr);
  const cosSep = dot(rs, re) / (Math.hypot(...rs) * Math.hypot(...re));
  const sep = Math.acos(Math.min(1, Math.max(-1, cosSep))) / DEG;
  const aS = Math.asin(R_SUN / s.rng) / DEG, aE = Math.asin(R_EARTH / e.rng) / DEG;
  let eclipse = 0; // 0 none, 1 partial, 2 total
  if (sep < aE + aS) eclipse = sep <= aE - aS ? 2 : 1;
  // Fraction of the Sun's disc left uncovered (circle-circle overlap)
  let lit = 1;
  if (eclipse) lit = 1 - overlap(aS, aE, sep) / (Math.PI * aS * aS);
  return { sun: s, earth: e, sep, sunRadius: aS, earthRadius: aE, eclipse, sunFraction: Math.max(0, lit) };
}
function vSub(p, fr) { return [p[0] - R_MOON * fr.up[0], p[1] - R_MOON * fr.up[1], p[2] - R_MOON * fr.up[2]]; }
function overlap(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

// A terrain horizon is an array of 360 elevation angles (deg), index = azimuth in whole degrees from north.
// Elevation of the mask at an azimuth, linearly interpolated. A null mask means a flat horizon at 0 deg.
export function maskAt(mask, az) {
  if (!mask) return 0;
  const a = ((az % 360) + 360) % 360, i = Math.floor(a), f = a - i;
  return mask[i] * (1 - f) + mask[(i + 1) % 360] * f;
}

// Is the Sun (its centre) above the local horizon, terrain included? Margin is the Sun's own radius when partial light counts.
// Direct sunlight reaches the site while any part of the Sun's disc (radius ~0.27 deg) is above the skyline,
// and the Earth is not covering the whole Sun. The disc matters: the polar Sun never climbs past ~1.5 deg.
export function sunVisible(sky, mask) {
  return sky.sun.el + sky.sunRadius > maskAt(mask, sky.sun.az) && sky.sunFraction > 0.001;
}
export function earthVisible(sky, mask, minEl = 0) {
  return sky.earth.el > Math.max(minEl, maskAt(mask, sky.earth.az));
}

// Run a site through a time window. Returns parallel arrays plus summary figures.
export function scan(site, t0, t1, stepMin = 30) {
  const step = stepMin * 60000;
  const n = Math.floor((t1 - t0) / step) + 1;
  const t = new Float64Array(n), sunEl = new Float32Array(n), sunAz = new Float32Array(n), eEl = new Float32Array(n), eAz = new Float32Array(n);
  const sunUp = new Uint8Array(n), earthUp = new Uint8Array(n), ecl = new Uint8Array(n), sunFrac = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ti = t0 + i * step;
    const s = skyAt(ti, site.frame);
    t[i] = ti; sunEl[i] = s.sun.el; sunAz[i] = s.sun.az; eEl[i] = s.earth.el; eAz[i] = s.earth.az;
    sunUp[i] = sunVisible(s, site.mask) ? 1 : 0;
    earthUp[i] = earthVisible(s, site.mask, site.minEarthEl || 0) ? 1 : 0;
    ecl[i] = s.eclipse; sunFrac[i] = s.sunFraction;
  }
  return { t, sunEl, sunAz, eEl, eAz, sunUp, earthUp, ecl, sunFrac, step, n };
}

// Longest run of zeros (darkness) or ones in a 0/1 series, in hours, and where it starts.
export function longestRun(arr, value, step) {
  let best = 0, bestAt = -1, cur = 0, curAt = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === value) { if (cur === 0) curAt = i; cur++; if (cur > best) { best = cur; bestAt = curAt; } } else cur = 0;
  }
  return { hours: best * step / 3600000, startIndex: bestAt };
}
// Number of separate runs of a value
export function countRuns(arr, value) {
  let c = 0, prev = -1;
  for (let i = 0; i < arr.length; i++) { if (arr[i] === value && prev !== value) c++; prev = arr[i]; }
  return c;
}

// Plain-language summary numbers for a scan
export function summarize(sc, site) {
  const sunPct = 100 * sc.sunUp.reduce((a, b) => a + b, 0) / sc.n;
  const earthPct = 100 * sc.earthUp.reduce((a, b) => a + b, 0) / sc.n;
  const dark = longestRun(sc.sunUp, 0, sc.step), light = longestRun(sc.sunUp, 1, sc.step);
  const noLink = longestRun(sc.earthUp, 0, sc.step);
  let maxEl = -90, eclHours = 0;
  for (let i = 0; i < sc.n; i++) { if (sc.sunEl[i] > maxEl) maxEl = sc.sunEl[i]; if (sc.ecl[i]) eclHours += sc.step / 3600000; }
  return { sunPct, earthPct, longestDarkH: dark.hours, longestLightH: light.hours, longestNoEarthH: noLink.hours, maxSunEl: maxEl, eclipseHours: eclHours, sunriseCount: countRuns(sc.sunUp, 1) };
}
