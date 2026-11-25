/**
 * Keyframe maths shared by both ends of the bridge: evaluating keys, cutting
 * a set of keys down to a time window without changing its motion, and
 * turning per-frame samples back into a small number of keys.
 */
import type { Anim, AnimVec2, Ease, Key, RGBA, Vec2 } from './format.ts';

export interface Ops<T> {
  lerp(a: T, b: T, p: number): T;
  /** A distance used to decide whether two values are "the same". */
  dist(a: T, b: T): number;
}

export const numOps: Ops<number> = {
  lerp: (a, b, p) => a + (b - a) * p,
  dist: (a, b) => Math.abs(a - b),
};

export const vecOps: Ops<Vec2> = {
  lerp: (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p }),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
};

export const rgbaOps: Ops<RGBA> = {
  lerp: (a, b, p) => ({
    r: a.r + (b.r - a.r) * p,
    g: a.g + (b.g - a.g) * p,
    b: a.b + (b.b - a.b) * p,
    a: a.a + (b.a - a.a) * p,
  }),
  dist: (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a)),
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** One coordinate of a cubic bezier that runs from 0 to 1 with inner controls p1, p2. */
function bezierCoord(u: number, p1: number, p2: number): number {
  const iu = 1 - u;
  return 3 * iu * iu * u * p1 + 3 * iu * u * u * p2 + u * u * u;
}

/** Finds the curve parameter u at which the bezier's x equals `x`. */
export function solveBezierU(x1: number, x2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bezierCoord(u, x1, x2) - x;
    if (Math.abs(err) < 1e-7) return u;
    const iu = 1 - u;
    const slope = 3 * iu * iu * x1 + 6 * iu * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(slope) < 1e-6) break;
    u -= err / slope;
    if (u < 0 || u > 1) break;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 48; i++) {
    const cx = bezierCoord(u, x1, x2);
    if (Math.abs(cx - x) < 1e-7) break;
    if (cx < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return u;
}

/** Approximation of Figma's normalised spring, only used when a spring has to be evaluated. */
function springProgress(bounce: number, p: number): number {
  if (p >= 1) return 1;
  if (p <= 0) return 0;
  const zeta = Math.max(0.05, 1 - clamp01(bounce));
  const w0 = 10;
  if (zeta >= 1) return 1 - Math.exp(-w0 * p) * (1 + w0 * p);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * p) * (Math.cos(wd * p) + ((zeta * w0) / wd) * Math.sin(wd * p));
}

/** Maps linear progress 0..1 through an ease. */
export function easeProgress(e: Ease | undefined, p: number): number {
  if (!e || e.type === 'linear') return p;
  if (e.type === 'hold') return p >= 1 ? 1 : 0;
  if (e.type === 'spring') return springProgress(e.bounce, p);
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return bezierCoord(solveBezierU(e.x1, e.x2, p), e.y1, e.y2);
}

export function evalKeys<T>(keys: Key<T>[], t: number, ops: Ops<T>): T {
  const first = keys[0]!;
  if (t <= first.t) return first.v;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  return ops.lerp(a.v, b.v, easeProgress(b.e, (t - a.t) / span));
}

export function evalAnim<T>(anim: Anim<T>, t: number, ops: Ops<T>): T {
  return anim.k && anim.k.length ? evalKeys(anim.k, t, ops) : anim.v;
}

export function evalAnimVec(av: AnimVec2, t: number): Vec2 {
  if (av.mode === 'vec') return evalAnim(av.a, t, vecOps);
  return { x: evalAnim(av.x, t, numOps), y: evalAnim(av.y, t, numOps) };
}

export function isAnimated<T>(anim: Anim<T>): boolean {
  return !!anim.k && anim.k.length > 1;
}

export function isAnimVecAnimated(av: AnimVec2): boolean {
  return av.mode === 'vec' ? isAnimated(av.a) : isAnimated(av.x) || isAnimated(av.y);
}

export function staticVec(x: number, y: number): AnimVec2 {
  return { mode: 'vec', a: { v: { x, y } } };
}

export function easeEquals(a: Ease | undefined, b: Ease | undefined, eps = 1e-4): boolean {
  const ta = a ? a.type : 'linear';
  const tb = b ? b.type : 'linear';
  if (ta !== tb) return false;
  if (a && b && a.type === 'bezier' && b.type === 'bezier') {
    return (
      Math.abs(a.x1 - b.x1) < eps &&
      Math.abs(a.y1 - b.y1) < eps &&
      Math.abs(a.x2 - b.x2) < eps &&
      Math.abs(a.y2 - b.y2) < eps
    );
  }
  if (a && b && a.type === 'spring' && b.type === 'spring') return Math.abs(a.bounce - b.bounce) < eps;
  return true;
}

/**
 * The control points of the part of a bezier ease between progress p0 and p1,
 * in that part's own 0..1 box. A piece of a cubic bezier is again a cubic
 * bezier - but when the handles of the whole reach far, a handle of the piece
 * can reach beyond its own box (x below 0 or above 1), which neither Figma nor
 * After Effects can hold. Null when the piece has no length.
 */
export function easePiece(e: { x1: number; y1: number; x2: number; y2: number }, p0: number, p1: number): { x1: number; y1: number; x2: number; y2: number } | null {
  const u0 = solveBezierU(e.x1, e.x2, p0);
  const u1 = solveBezierU(e.x1, e.x2, p1);
  const mix = (m: number, n: number, s: number): number => m + (n - m) * s;
  // Blossom of a cubic: de Casteljau with a different parameter at each level.
  const blossom = (c: number[], a: number, b: number, d: number): number => {
    const q0 = mix(c[0]!, c[1]!, a);
    const q1 = mix(c[1]!, c[2]!, a);
    const q2 = mix(c[2]!, c[3]!, a);
    return mix(mix(q0, q1, b), mix(q1, q2, b), d);
  };
  const px = [0, e.x1, e.x2, 1];
  const py = [0, e.y1, e.y2, 1];
  const X = [blossom(px, u0, u0, u0), blossom(px, u0, u0, u1), blossom(px, u0, u1, u1), blossom(px, u1, u1, u1)];
  const Y = [blossom(py, u0, u0, u0), blossom(py, u0, u0, u1), blossom(py, u0, u1, u1), blossom(py, u1, u1, u1)];
  const dx = X[3]! - X[0]!;
  const dy = Y[3]! - Y[0]!;
  if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) return null;
  return { x1: (X[1]! - X[0]!) / dx, y1: (Y[1]! - Y[0]!) / dy, x2: (X[2]! - X[0]!) / dx, y2: (Y[2]! - Y[0]!) / dy };
}

/**
 * The ease that reproduces the part of `e` between progress p0 and p1.
 * A piece of a cubic bezier is again a cubic bezier, so nothing is lost -
 * unless a handle of the piece reaches beyond its box (see easePiece), in
 * which case it is pulled back to the edge.
 */
export function splitEase(e: Ease | undefined, p0: number, p1: number): Ease {
  const whole = p0 <= 1e-9 && p1 >= 1 - 1e-9;
  if (!e || e.type === 'linear') return { type: 'linear' };
  if (e.type === 'hold') return p1 >= 1 - 1e-9 ? { type: 'hold' } : { type: 'linear' };
  if (whole) return e;
  if (e.type === 'spring') return { type: 'linear' };
  const piece = easePiece(e, p0, p1);
  if (!piece) return { type: 'linear' };
  return { type: 'bezier', x1: clamp01(piece.x1), y1: piece.y1, x2: clamp01(piece.x2), y2: piece.y2 };
}

export function shiftKeys<T>(keys: Key<T>[], dt: number): Key<T>[] {
  if (!dt) return keys;
  return keys.map((k) => (k.e ? { t: k.t + dt, v: k.v, e: k.e } : { t: k.t + dt, v: k.v }));
}

/**
 * Keeps only the part of the keys inside [t0, t1], adding a key on each cut
 * edge so the motion inside the window is unchanged. A single returned key
 * means the value is constant inside the window.
 */
export function clipKeys<T>(keys: Key<T>[], t0: number, t1: number, ops: Ops<T>): Key<T>[] {
  if (!keys.length) return [];
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (last.t <= t0) return [{ t: t0, v: last.v }];
  if (first.t >= t1) return [{ t: t0, v: first.v }];

  const out: Key<T>[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (k.t < t0) continue;
    const prev = i > 0 ? keys[i - 1] : undefined;
    let p0 = 0;
    if (prev && prev.t < t0 && k.t > t0) {
      p0 = (t0 - prev.t) / (k.t - prev.t);
      out.push({ t: t0, v: evalKeys(keys, t0, ops) });
    }
    if (k.t <= t1) {
      const key: Key<T> = { t: k.t, v: k.v };
      if (out.length) {
        const e = p0 > 0 ? splitEase(k.e, p0, 1) : k.e;
        if (e) key.e = e;
      }
      out.push(key);
    } else {
      if (!prev) break;
      const p1 = (t1 - prev.t) / (k.t - prev.t);
      out.push({ t: t1, v: evalKeys(keys, t1, ops), e: splitEase(k.e, p0, p1) });
      break;
    }
  }
  return out;
}

export function keysAreConstant<T>(keys: Key<T>[], ops: Ops<T>, eps: number): boolean {
  if (keys.length < 2) return true;
  const first = keys[0]!.v;
  for (let i = 1; i < keys.length; i++) {
    if (ops.dist(first, keys[i]!.v) > eps) return false;
  }
  return true;
}

/**
 * Moves an animation by `shift` seconds and restricts it to [t0, t1].
 * Returns a static value when nothing changes inside that window.
 */
export function windowAnim<T>(anim: Anim<T>, shift: number, t0: number, t1: number, ops: Ops<T>, eps = 1e-6): Anim<T> {
  if (!anim.k || anim.k.length === 0) return { v: anim.v };
  const clipped = clipKeys(shiftKeys(anim.k, shift), t0, t1, ops);
  if (clipped.length === 0) return { v: anim.v };
  if (keysAreConstant(clipped, ops, eps)) return { v: clipped[0]!.v };
  return { v: anim.v, k: clipped };
}

/**
 * Reduces evenly sampled values to the fewest linear keys that stay within
 * `tol` of every sample. Returns an empty list when the value never moves.
 */
export function simplifySamples<T>(times: number[], values: T[], ops: Ops<T>, tol: number): Key<T>[] {
  const n = values.length;
  if (n === 0) return [];
  let moving = false;
  for (let i = 1; i < n; i++) {
    if (ops.dist(values[0]!, values[i]!) > tol) {
      moving = true;
      break;
    }
  }
  if (!moving) return [];

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const span = times[b]! - times[a]!;
    let worst = -1;
    let worstErr = tol;
    for (let i = a + 1; i < b; i++) {
      const p = span > 0 ? (times[i]! - times[a]!) / span : 0;
      const err = ops.dist(values[i]!, ops.lerp(values[a]!, values[b]!, p));
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const keys: Key<T>[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) keys.push({ t: times[i]!, v: values[i]! });
  }
  return keys;
}

/**
 * The cubic-bezier ease that best carries samples a..b from the first value
 * to the last, or null when no single ease stays within `tol` of them.
 * `progress` is how far each sample has travelled towards the last value.
 */
function fitEase(tau: number[], progress: number[], span: number, tol: number): Ease | null {
  const n = tau.length;
  let linearErr = 0;
  for (let i = 0; i < n; i++) linearErr = Math.max(linearErr, Math.abs(progress[i]! - tau[i]!) * span);
  if (linearErr <= tol) return { type: 'linear' };

  let best = { err: Infinity, x1: 0, y1: 0, x2: 1, y2: 1 };
  const attempt = (x1: number, x2: number): void => {
    // With the handles' x fixed, the curve is linear in y1 and y2: least squares in closed form.
    let aa = 0;
    let ab = 0;
    let bb = 0;
    let ar = 0;
    let br = 0;
    const basis: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const u = solveBezierU(x1, x2, tau[i]!);
      const iu = 1 - u;
      const a = 3 * iu * iu * u;
      const b = 3 * iu * u * u;
      const c = u * u * u;
      const r = progress[i]! - c;
      aa += a * a;
      ab += a * b;
      bb += b * b;
      ar += a * r;
      br += b * r;
      basis.push([a, b, c]);
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-12) return;
    const y1 = Math.max(-20, Math.min(20, (ar * bb - br * ab) / det));
    const y2 = Math.max(-20, Math.min(20, (aa * br - ab * ar) / det));
    let err = 0;
    for (let i = 0; i < n; i++) {
      const [a, b, c] = basis[i]!;
      err = Math.max(err, Math.abs(a * y1 + b * y2 + c - progress[i]!) * span);
      if (err >= best.err) return;
    }
    best = { err, x1, y1, x2, y2 };
  };
  // Coarse to fine over where the two handles sit in time.
  let centre = { x1: 0.5, x2: 0.5 };
  for (const [reach, step] of [
    [0.5, 0.1],
    [0.1, 0.02],
    [0.02, 0.004],
    [0.004, 0.0008],
  ] as Array<[number, number]>) {
    for (let x1 = centre.x1 - reach; x1 <= centre.x1 + reach + 1e-9; x1 += step) {
      for (let x2 = centre.x2 - reach; x2 <= centre.x2 + reach + 1e-9; x2 += step) {
        if (x1 < -1e-9 || x1 > 1 + 1e-9 || x2 < -1e-9 || x2 > 1 + 1e-9) continue;
        attempt(clamp01(x1), clamp01(x2));
      }
    }
    if (!isFinite(best.err)) return null;
    centre = { x1: best.x1, x2: best.x2 };
  }
  if (best.err > tol) return null;
  const r4 = (v: number): number => Math.round(v * 10000) / 10000;
  return { type: 'bezier', x1: r4(best.x1), y1: r4(best.y1), x2: r4(best.x2), y2: r4(best.y2) };
}

/**
 * Turns evenly sampled values back into keyframes with easing: stretches
 * where nothing moves become holds, and each move in between is described by
 * one cubic-bezier ease when one fits (which it does exactly for anything an
 * eased keyframe or an easing expression produced), or split further when
 * not. Needs a straight-line distance, so it is for numbers and points, not
 * colours. Returns an empty list when the value never moves.
 */
export function fitSamples<T>(times: number[], values: T[], ops: Ops<T>, tol: number): Key<T>[] {
  const n = values.length;
  if (n === 0) return [];
  let moving = false;
  for (let i = 1; i < n; i++) {
    if (ops.dist(values[0]!, values[i]!) > tol) {
      moving = true;
      break;
    }
  }
  if (!moving) return [];

  const still = tol / 8;
  const keys: Key<T>[] = [{ t: times[0]!, v: values[0]! }];

  const emit = (a: number, b: number): void => {
    const key: Key<T> = { t: times[b]!, v: values[b]! };
    if (b - a === 1) {
      keys.push(key);
      return;
    }
    const va = values[a]!;
    const vb = values[b]!;
    const span = ops.dist(va, vb);
    const duration = times[b]! - times[a]!;
    let ease: Ease | null = null;
    let straight = span > tol && duration > 0;
    const tau: number[] = [];
    const progress: number[] = [];
    if (straight) {
      for (let i = a; i <= b; i++) {
        // Where the sample sits along the straight line from va to vb.
        const d1 = ops.dist(va, values[i]!);
        const d2 = ops.dist(vb, values[i]!);
        const p = (d1 * d1 - d2 * d2 + span * span) / (2 * span * span);
        if (ops.dist(values[i]!, ops.lerp(va, vb, p)) > tol) {
          straight = false;
          break;
        }
        tau.push((times[i]! - times[a]!) / duration);
        progress.push(p);
      }
    }
    // A long move may stray a little more: a thousandth of the way is not something anyone sees.
    if (straight) ease = fitEase(tau, progress, span, Math.max(tol, span * 0.001));
    if (ease) {
      if (ease.type !== 'linear') key.e = ease;
      keys.push(key);
      return;
    }
    // No single ease fits: cut where the samples stray furthest from a straight run and try both halves.
    let worst = a + 1;
    let worstErr = -1;
    for (let i = a + 1; i < b; i++) {
      const p = duration > 0 ? (times[i]! - times[a]!) / duration : 0;
      const err = span > tol ? ops.dist(values[i]!, ops.lerp(va, vb, p)) : ops.dist(values[i]!, va);
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    emit(a, worst);
    emit(worst, b);
  };

  // Cut the samples where the value starts or stops moving.
  const cuts: number[] = [0];
  for (let i = 1; i < n - 1; i++) {
    const restBefore = ops.dist(values[i]!, values[i - 1]!) <= still;
    const restAfter = ops.dist(values[i + 1]!, values[i]!) <= still;
    if (restBefore !== restAfter) cuts.push(i);
  }
  cuts.push(n - 1);
  for (let c = 1; c < cuts.length; c++) {
    const a = cuts[c - 1]!;
    const b = cuts[c]!;
    if (b <= a) continue;
    let rest = true;
    for (let i = a + 1; i <= b && rest; i++) rest = ops.dist(values[i]!, values[a]!) <= still * (b - a + 1);
    if (rest && ops.dist(values[a]!, values[b]!) <= tol) keys.push({ t: times[b]!, v: values[b]! });
    else emit(a, b);
  }
  return keys;
}
