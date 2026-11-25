/**
 * Brings animations from "seconds inside their own composition" onto the one
 * timeline a Figma top-level frame has.
 *
 * A nested composition does not have to play straight through: it starts
 * later, and time remapping can speed it up, freeze it or run it backwards.
 * So the link between the timeline and a composition's own time is kept as a
 * list of straight pieces ("from timeline second 2.16 to 4.16 the composition
 * runs from 2.16 to 7.8"), and every animation is carried across piece by
 * piece. Within a piece a key keeps its easing, so nothing is resampled.
 */
import type { Anim, AnimVec2, Ease, Key, Vec2 } from '../../../shared/format.ts';
import type { Ops } from '../../../shared/anim.ts';
import { clipKeys, evalAnim, evalKeys, keysAreConstant, numOps, vecOps } from '../../../shared/anim.ts';

/** While the timeline runs from t0 to t1, the composition's own time runs evenly from s0 to s1. */
export interface Seg {
  t0: number;
  t1: number;
  s0: number;
  s1: number;
}

export interface TimeCtx {
  /** Covers the whole timeline, in order. */
  segs: Seg[];
  /** Length of the timeline in seconds. */
  duration: number;
  /** Timeline time whose look becomes the static design. */
  poster: number;
}

/** A prepared value: `keys` is only present when the value really moves. */
export interface P<T> {
  rest: T;
  keys?: Key<T>[];
}

export type PVec =
  | { mode: 'static'; rest: Vec2 }
  | { mode: 'vec'; rest: Vec2; keys: Key<Vec2>[] }
  | { mode: 'split'; rest: Vec2; x?: Key<number>[]; y?: Key<number>[] };

const EPS = 1e-6;

export function rootTime(duration: number, poster: number): TimeCtx {
  return { segs: [{ t0: 0, t1: duration, s0: 0, s1: duration }], duration, poster };
}

/** The time link of a composition held on one moment of its own time for the whole timeline. */
export function frozenTime(tc: TimeCtx, at: number): TimeCtx {
  return { segs: [{ t0: 0, t1: tc.duration, s0: at, s1: at }], duration: tc.duration, poster: tc.poster };
}

/** A short text that is the same for two time links exactly when they are the same link. */
export function timeKey(tc: TimeCtx): string {
  const r = (n: number): number => Math.round(n * 10000) / 10000;
  return tc.segs.map((s) => `${r(s.t0)},${r(s.t1)},${r(s.s0)},${r(s.s1)}`).join(';');
}

/** Times at which a remap curve bends. Eased stretches are cut into short straight ones. */
function remapBreaks(keys: Key<number>[]): number[] {
  const out: number[] = [];
  keys.forEach((k, i) => {
    const prev = keys[i - 1];
    if (prev && k.e && k.e.type !== 'linear' && k.e.type !== 'hold') {
      for (let j = 1; j < 8; j++) out.push(prev.t + ((k.t - prev.t) * j) / 8);
    }
    out.push(k.t);
  });
  return out;
}

/**
 * The time link of a composition nested in another one: it either starts at
 * `startTime`, or follows a time-remap curve.
 */
export function nestTime(tc: TimeCtx, startTime: number, remap?: Anim<number>): TimeCtx {
  const keys = remap?.k && remap.k.length ? remap.k : null;
  const at = (s: number): number => (remap ? evalAnim(remap, s, numOps) : s - startTime);
  const breaks = keys ? remapBreaks(keys) : [];
  const segs: Seg[] = [];
  for (const seg of tc.segs) {
    const span = seg.s1 - seg.s0;
    if (Math.abs(span) < EPS || !breaks.length) {
      segs.push({ t0: seg.t0, t1: seg.t1, s0: at(seg.s0), s1: at(Math.abs(span) < EPS ? seg.s0 : seg.s1) });
      continue;
    }
    const lo = Math.min(seg.s0, seg.s1);
    const hi = Math.max(seg.s0, seg.s1);
    const inner = breaks.filter((b) => b > lo + EPS && b < hi - EPS).sort((a, b) => (span > 0 ? a - b : b - a));
    const points = [seg.s0, ...inner, seg.s1];
    for (let i = 0; i + 1 < points.length; i++) {
      const pa = points[i]!;
      const pb = points[i + 1]!;
      // Just short of the far end, so a hold key keeps its value right up to the jump.
      const nearEnd = pb - (pb - pa) * 1e-7;
      segs.push({
        t0: seg.t0 + ((pa - seg.s0) / span) * (seg.t1 - seg.t0),
        t1: seg.t0 + ((pb - seg.s0) / span) * (seg.t1 - seg.t0),
        s0: at(pa),
        s1: at(nearEnd),
      });
    }
  }
  // Join neighbours that run at the same pace: fewer pieces, fewer cuts in the keys.
  const joined: Seg[] = [];
  for (const s of segs) {
    const last = joined[joined.length - 1];
    if (last) {
      const paceA = (last.s1 - last.s0) / Math.max(last.t1 - last.t0, EPS);
      const paceB = (s.s1 - s.s0) / Math.max(s.t1 - s.t0, EPS);
      if (Math.abs(last.s1 - s.s0) < 1e-5 && Math.abs(paceA - paceB) < 1e-5) {
        last.t1 = s.t1;
        last.s1 = s.s1;
        continue;
      }
    }
    joined.push({ ...s });
  }
  return { segs: joined, duration: tc.duration, poster: tc.poster };
}

function reverseEase(e: Ease | undefined): Ease | undefined {
  if (!e || e.type !== 'bezier') return e;
  return { type: 'bezier', x1: 1 - e.x2, y1: 1 - e.y2, x2: 1 - e.x1, y2: 1 - e.y1 };
}

/** Carries keys from a composition's own time onto the timeline. */
function mapKeys<T>(keys: Key<T>[], tc: TimeCtx, ops: Ops<T>): Key<T>[] {
  const out: Key<T>[] = [];
  const push = (k: Key<T>): void => {
    const last = out[out.length - 1];
    if (last && k.t <= last.t + EPS) {
      if (ops.dist(last.v, k.v) <= 1e-9) return;
      // Two values at one moment: the time link jumps here.
      out.push({ t: last.t + 0.0005, v: k.v, e: { type: 'hold' } });
      return;
    }
    out.push(k);
  };
  for (const seg of tc.segs) {
    const dt = seg.t1 - seg.t0;
    if (dt <= EPS) continue;
    const ds = seg.s1 - seg.s0;
    if (Math.abs(ds) < EPS) {
      push({ t: seg.t0, v: evalKeys(keys, seg.s0, ops) });
      continue;
    }
    if (out.length) push({ t: seg.t0, v: evalKeys(keys, seg.s0, ops) });
    if (ds > 0) {
      const part = clipKeys(keys, seg.s0, seg.s1, ops);
      part.forEach((k, i) => {
        const key: Key<T> = { t: seg.t0 + ((k.t - seg.s0) / ds) * dt, v: k.v };
        if (i > 0 && k.e) key.e = k.e;
        push(key);
      });
    } else {
      const part = clipKeys(keys, seg.s1, seg.s0, ops);
      for (let i = part.length - 1; i >= 0; i--) {
        const k = part[i]!;
        const key: Key<T> = { t: seg.t0 + ((seg.s0 - k.t) / -ds) * dt, v: k.v };
        // Played backwards, the ease that led up to the later key now leads away from it.
        const later = part[i + 1];
        const e = later ? reverseEase(later.e) : undefined;
        if (e) key.e = e;
        push(key);
      }
    }
  }
  return out;
}

export function prep<T>(anim: Anim<T>, ops: Ops<T>, tc: TimeCtx): P<T> {
  if (!anim.k || anim.k.length === 0) return { rest: anim.v };
  const keys = mapKeys(anim.k, tc, ops);
  if (!keys.length) return { rest: anim.v };
  if (keys.length < 2 || keysAreConstant(keys, ops, EPS)) return { rest: keys[0]!.v };
  return { rest: evalKeys(keys, tc.poster, ops), keys };
}

export function prepVec(av: AnimVec2, tc: TimeCtx): PVec {
  if (av.mode === 'vec') {
    const p = prep(av.a, vecOps, tc);
    return p.keys ? { mode: 'vec', rest: p.rest, keys: p.keys } : { mode: 'static', rest: p.rest };
  }
  const px = prep(av.x, numOps, tc);
  const py = prep(av.y, numOps, tc);
  const rest = { x: px.rest, y: py.rest };
  if (!px.keys && !py.keys) return { mode: 'static', rest };
  const out: PVec = { mode: 'split', rest };
  if (px.keys) out.x = px.keys;
  if (py.keys) out.y = py.keys;
  return out;
}

export function pvAnimated(pv: PVec): boolean {
  return pv.mode !== 'static';
}

/** Applies one function per axis to the rest value and every key. */
export function mapPVec(pv: PVec, fx: (x: number) => number, fy: (y: number) => number): PVec {
  const rest = { x: fx(pv.rest.x), y: fy(pv.rest.y) };
  if (pv.mode === 'static') return { mode: 'static', rest };
  if (pv.mode === 'vec') {
    return { mode: 'vec', rest, keys: pv.keys.map((k) => ({ ...k, v: { x: fx(k.v.x), y: fy(k.v.y) } })) };
  }
  const out: PVec = { mode: 'split', rest };
  if (pv.x) out.x = pv.x.map((k) => ({ ...k, v: fx(k.v) }));
  if (pv.y) out.y = pv.y.map((k) => ({ ...k, v: fy(k.v) }));
  return out;
}

export function mapP(p: P<number>, f: (v: number) => number): P<number> {
  const out: P<number> = { rest: f(p.rest) };
  if (p.keys) out.keys = p.keys.map((k) => ({ ...k, v: f(k.v) }));
  return out;
}

export interface OpacityPlan extends P<number> {
  /** Not visible at any moment of the timeline: outside its in/out range, or at zero opacity throughout. */
  neverVisible?: boolean;
}

/** The stretches of the timeline during which the composition's own time is inside [tin, tout). */
function shownSpans(window: { tin: number; tout: number }, tc: TimeCtx): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const add = (a: number, b: number): void => {
    if (b - a <= 1e-4) return;
    const last = spans[spans.length - 1];
    if (last && a <= last[1] + 1e-4) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  };
  for (const seg of tc.segs) {
    const ds = seg.s1 - seg.s0;
    if (Math.abs(ds) < EPS) {
      if (seg.s0 >= window.tin - 1e-4 && seg.s0 < window.tout - 1e-4) add(seg.t0, seg.t1);
      continue;
    }
    const toTimeline = (s: number): number => seg.t0 + ((s - seg.s0) / ds) * (seg.t1 - seg.t0);
    const a = toTimeline(window.tin);
    const b = toTimeline(window.tout);
    add(Math.max(Math.min(a, b), seg.t0), Math.min(Math.max(a, b), seg.t1));
  }
  return spans;
}

/**
 * Figma has no in and out points, so a layer that is only visible for part of
 * the timeline gets them written into its opacity: zero, a hard step up at the
 * in point, the layer's own opacity animation in between, a hard step down at
 * the out point.
 */
export function prepOpacity(anim: Anim<number>, window: { tin: number; tout: number } | undefined, tc: TimeCtx): OpacityPlan {
  const base = prep(anim, numOps, tc);
  const dark = (p: P<number>): boolean => (p.keys ? p.keys.every((k) => k.v <= 1e-4) : p.rest <= 1e-4);
  if (dark(base)) return { rest: 0, neverVisible: true };
  if (!window) return base;

  const frameish = 1e-4;
  const spans = shownSpans(window, tc);
  if (!spans.length) return { rest: 0, neverVisible: true };
  if (spans.length === 1 && spans[0]![0] <= frameish && spans[0]![1] >= tc.duration - frameish) return base;

  const out: Key<number>[] = [];
  for (const [a, b] of spans) {
    const inner: Key<number>[] = base.keys ? clipKeys(base.keys, a, b, numOps) : [{ t: a, v: base.rest }];
    if (!inner.length) inner.push({ t: a, v: base.rest });
    if (a > frameish) {
      if (!out.length) out.push({ t: 0, v: 0 });
      if (inner[0]!.t > a + EPS) inner.unshift({ t: a, v: inner[0]!.v });
      inner[0] = { t: a, v: inner[0]!.v, e: { type: 'hold' } };
    }
    if (b < tc.duration - frameish) {
      const last = inner[inner.length - 1]!;
      if (last.t >= b - EPS) {
        // The opacity was still animating when the layer ends: finish a hair early, then cut.
        const prev = inner[inner.length - 2];
        if (prev && Math.abs(prev.v - last.v) < EPS) inner.pop();
        else last.t = Math.max(b - 0.001, prev ? (prev.t + b) / 2 : a);
      }
      out.push(...inner, { t: b, v: 0, e: { type: 'hold' } });
    } else {
      out.push(...inner);
    }
  }

  if (out.length < 2 || keysAreConstant(out, numOps, EPS)) {
    const value = out.length ? out[0]!.v : base.rest;
    return value <= 1e-4 ? { rest: 0, neverVisible: true } : { rest: value };
  }
  const plan: OpacityPlan = { rest: evalKeys(out, tc.poster, numOps), keys: out };
  if (dark(plan)) return { rest: 0, neverVisible: true };
  return plan;
}
