// Terrain from NASA LRO/LOLA (south polar digital elevation model, 80S to 90S, polar stereographic).
// A site's horizon is found by marching a ray across the elevation map in each compass direction and keeping the
// highest angle above the local horizontal. The Moon has no atmosphere, so this is the whole story: no refraction.
import { R_MOON } from "./engine.js";

const R = R_MOON * 1000;           // m
const BASE = 1737400;              // m, the reference sphere LOLA heights are relative to
const DEG = Math.PI / 180;

export class Terrain {
  // data: Int16Array of absolute samples (units of `unit` metres), n x n, row 0 at the top (y = +half)
  constructor({ n, px, unit, data }) {
    this.n = n; this.px = px; this.unit = unit; this.data = data;
    this.half = n * px / 2;        // metres from the pole to the map edge
  }
  // Polar stereographic (south): x = 2R px/(1-pz), y = 2R py/(1-pz) with p the unit vector in ME axes. Central meridian = +y.
  static project(p) { const k = 2 * R / (1 - p[2]); return [k * p[1], k * p[0]]; }
  heightAtXY(x, y) { // bilinear, metres above the 1737.4 km sphere; NaN outside the map
    const c = (x + this.half) / this.px - 0.5, r = (this.half - y) / this.px - 0.5;
    if (!(c >= 0 && r >= 0 && c < this.n - 1 && r < this.n - 1)) return NaN;
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, n = this.n, d = this.data;
    const a = d[r0 * n + c0], b = d[r0 * n + c0 + 1], e = d[(r0 + 1) * n + c0], f = d[(r0 + 1) * n + c0 + 1];
    return ((a * (1 - fc) + b * fc) * (1 - fr) + (e * (1 - fc) + f * fc) * fr) * this.unit;
  }
  heightAt(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG, cl = Math.cos(la);
    const [x, y] = Terrain.project([cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)]);
    return this.heightAtXY(x, y);
  }
  covers(latDeg) { return latDeg <= -80.2; }

  // Horizon profile for a site: elevation angle (deg) of the terrain skyline at each whole azimuth (0 = north, 90 = east).
  // mast: height of the antenna/array above the ground (m). maxKm: how far to look.
  horizon(latDeg, lonDeg, { mast = 2, maxKm = 250, azStep = 1 } = {}) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    const cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    const up = [cl * co, cl * so, sl], east = [-so, co, 0], north = [-sl * co, -sl * so, cl];
    const [sx, sy] = Terrain.project(up);
    const ground = this.heightAtXY(sx, sy);
    if (Number.isNaN(ground)) return null;
    const r0 = BASE + ground + mast;
    const out = new Float32Array(Math.round(360 / azStep));
    const maxS = maxKm * 1000;
    for (let a = 0; a < out.length; a++) {
      const ca = Math.cos(a * azStep * DEG), sa = Math.sin(a * azStep * DEG);
      const dir = [ca * north[0] + sa * east[0], ca * north[1] + sa * east[1], ca * north[2] + sa * east[2]];
      let best = -Infinity, s = this.px / 2;
      while (s < maxS) {
        const th = s / R, ct = Math.cos(th), st = Math.sin(th);
        const p = [ct * up[0] + st * dir[0], ct * up[1] + st * dir[1], ct * up[2] + st * dir[2]];
        const k = 2 * R / (1 - p[2]);
        const h = this.heightAtXY(k * p[1], k * p[0]);
        if (Number.isNaN(h)) break;
        const r1 = BASE + h;
        const t = (r1 * ct - r0) / (r1 * st);
        if (t > best) best = t;
        s += s < 10000 ? this.px / 2 : s < 60000 ? this.px : this.px * 2;
      }
      out[a] = best === -Infinity ? 0 : Math.atan(best) / DEG;
    }
    return out;
  }
}

// Decode the packed file: gzip(Int16LE row-deltas); returns absolute samples.
export function unpack(deltaInt16, n) {
  const out = new Int16Array(n * n);
  for (let r = 0; r < n; r++) { let acc = 0; for (let c = 0; c < n; c++) { acc += deltaInt16[r * n + c]; out[r * n + c] = acc; } }
  return out;
}
