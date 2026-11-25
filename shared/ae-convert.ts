/**
 * Turns the raw After Effects read-out (see ae-raw.ts) into a bridge document.
 *
 * This is where After Effects' way of describing motion is translated:
 * speed/influence handles become cubic-bezier eases, percentages become
 * multipliers, shape groups become elements, and everything that cannot be
 * carried over is reported as a warning instead of being dropped silently.
 */
import type {
  Anim,
  AnimVec2,
  Asset,
  BlendMode,
  BridgeDoc,
  Comp,
  CompContent,
  CompSet,
  Content,
  DropShadow,
  Ease,
  Element,
  Key,
  Layer,
  Paint,
  RGBA,
  ShapeStyle,
  SubPath,
  TextContent,
  Transform,
  Vec2,
  Warning,
} from './format.ts';
import { FORMAT_NAME, FORMAT_VERSION } from './format.ts';
import type {
  RawComp,
  RawController,
  RawDump,
  RawEffect,
  RawKey,
  RawLayer,
  RawProp,
  RawShapeItem,
  RawShapePath,
  RawText,
} from './ae-raw.ts';
import type { Ops } from './anim.ts';
import {
  easeEquals,
  evalAnim,
  fitSamples,
  isAnimated,
  isAnimVecAnimated,
  keysAreConstant,
  numOps,
  rgbaOps,
  simplifySamples,
  staticVec,
  vecOps,
} from './anim.ts';
import { ellipseSubPath, rectSubPath, reversed, signedArea, starSubPath } from './geometry.ts';

/** An image the panel has to load before the document can be sent. */
export interface AssetRequest {
  assetId: string;
  footageId: string;
  name: string;
  /** Source file on disk, when After Effects knows one. */
  file: string | null;
  still: boolean;
  /** Source time to grab when the footage is not a still. */
  time: number;
}

export interface ConvertResult {
  doc: BridgeDoc;
  assets: AssetRequest[];
}

const TOL = { px: 0.05, scale: 0.0005, degrees: 0.05, unit: 0.002 };
/** Sampled motion is fitted with easing curves; a curve may stray this many times the tolerance above. */
const FIT = 4;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const identity = (v: number): number => v;

function dim(v: number | number[] | null | undefined, d: number): number {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v[d] ?? 0;
  return 0;
}

function isRawAnimated(p: RawProp | null | undefined): boolean {
  return !!p && (!!p.s || (!!p.k && p.k.length > 1 && !p.ex));
}

// ------------------------------------------------------------------ easing

/**
 * After Effects stores, per key side, a speed and an "influence" (how far the
 * handle reaches towards the neighbouring key, in percent). Between two keys
 * that is exactly a cubic bezier on a time/value graph; this normalises it to
 * the 0..1 box used by CSS and Figma.
 *
 * `delta` is how far the value travels between the keys (path length for
 * positions), `d` picks the dimension for values that ease each axis apart.
 */
function segmentEase(a: RawKey, b: RawKey, d: number, delta: number): Ease | undefined {
  if (a.oi === 'h') return { type: 'hold' };
  if (a.oi === 'l' && b.ii === 'l') return undefined;
  const duration = b.t - a.t;
  if (duration <= 0) return undefined;
  const average = delta / duration;
  if (Math.abs(average) < 1e-9) return undefined;

  let x1 = 0;
  let y1 = 0;
  if (a.oi !== 'l') {
    const out = a.oe[d] ?? a.oe[0];
    if (out) {
      x1 = clamp01(out.i / 100);
      y1 = (out.s / average) * x1;
    }
  }
  let x2 = 1;
  let y2 = 1;
  if (b.ii !== 'l') {
    const inn = b.ie[d] ?? b.ie[0];
    if (inn) {
      const reach = clamp01(inn.i / 100);
      x2 = 1 - reach;
      y2 = 1 - (inn.s / average) * reach;
    }
  }
  if (Math.abs(x1 - y1) < 1e-3 && Math.abs(x2 - y2) < 1e-3) return undefined;
  const limit = (n: number): number => Math.max(-20, Math.min(20, n));
  return { type: 'bezier', x1: round4(x1), y1: round4(limit(y1)), x2: round4(x2), y2: round4(limit(y2)) };
}

function sampleTimes(count: number, dt: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(round4(i * dt));
  return times;
}

function finish<T>(rest: T, keys: Key<T>[], ops: Ops<T>, eps: number): Anim<T> {
  if (keys.length < 2 || keysAreConstant(keys, ops, eps)) return { v: keys.length ? keys[0]!.v : rest };
  return { v: rest, k: keys };
}

/**
 * Moves per-frame samples of an angle by whole turns, so that no two
 * neighbouring frames are more than half a turn apart. An expression may hand
 * back any of the values that look the same - Duik's IK rigs add 360 below a
 * limit, wrap with `% 360` or follow `atan2` across 180 - and After Effects
 * only ever shows whole frames, where 10 and 370 degrees are one picture. The
 * keys made from the samples are played between the frames too, so a step of
 * a turn would spin the layer once round between two frames.
 */
export function unwrapDegrees(values: number[]): number[] {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    const step = out[i]! - out[i - 1]!;
    if (Math.abs(step) > 180) out[i] = out[i]! - 360 * Math.round(step / 360);
  }
  return out;
}

function convertScalar(
  raw: RawProp | null | undefined,
  fallback: number,
  map: (v: number) => number,
  tol: number,
  d = 0,
  angle = false,
): Anim<number> {
  if (!raw) return { v: map(fallback) };
  const rest = map(raw.v === null ? fallback : dim(raw.v, d));
  if (raw.s) {
    const mapped = raw.s.v.map((v) => map(dim(v, d)));
    const values = angle ? unwrapDegrees(mapped) : mapped;
    const keys = fitSamples(sampleTimes(values.length, raw.s.dt), values, numOps, tol * FIT);
    return keys.length ? { v: rest, k: keys } : { v: rest };
  }
  if (raw.ex || !raw.k || raw.k.length < 2) return { v: rest };
  const keys: Key<number>[] = raw.k.map((k, idx) => {
    const key: Key<number> = { t: k.t, v: map(dim(k.v, d)) };
    if (idx > 0) {
      const prev = raw.k![idx - 1]!;
      const e = segmentEase(prev, k, d, dim(k.v, d) - dim(prev.v, d));
      if (e) key.e = e;
    }
    return key;
  });
  return finish(rest, keys, numOps, tol / 10);
}

/**
 * A two-axis value. `spatial` values (positions) ease along their path with
 * one curve; others (scale, size) may ease each axis differently, in which
 * case the axes are split into two independent animations.
 */
function convertVec(
  raw: RawProp | null | undefined,
  fallback: [number, number],
  map: (v: number) => number,
  tol: number,
  kind: 'spatial' | 'multi',
): AnimVec2 {
  if (!raw) return staticVec(map(fallback[0]), map(fallback[1]));
  const at = (v: number | number[] | null): Vec2 =>
    v === null ? { x: map(fallback[0]), y: map(fallback[1]) } : { x: map(dim(v, 0)), y: map(dim(v, 1)) };
  const rest = at(raw.v);
  if (raw.s) {
    const values = raw.s.v.map((v) => at(v));
    const keys = fitSamples(sampleTimes(values.length, raw.s.dt), values, vecOps, tol * FIT);
    return { mode: 'vec', a: keys.length ? { v: rest, k: keys } : { v: rest } };
  }
  if (raw.ex || !raw.k || raw.k.length < 2) return { mode: 'vec', a: { v: rest } };

  const keys: Key<Vec2>[] = [];
  let shareable = true;
  for (let idx = 0; idx < raw.k.length; idx++) {
    const k = raw.k[idx]!;
    const key: Key<Vec2> = { t: k.t, v: at(k.v) };
    if (idx > 0) {
      const prev = raw.k[idx - 1]!;
      const dx = dim(k.v, 0) - dim(prev.v, 0);
      const dy = dim(k.v, 1) - dim(prev.v, 1);
      let e: Ease | undefined;
      if (kind === 'spatial') {
        e = segmentEase(prev, k, 0, Math.hypot(dx, dy));
      } else {
        const ex = segmentEase(prev, k, 0, dx);
        const ey = segmentEase(prev, k, 1, dy);
        if (Math.abs(dx) < 1e-6) e = ey;
        else if (Math.abs(dy) < 1e-6) e = ex;
        else if (easeEquals(ex, ey, 2e-3)) e = ex;
        else shareable = false;
      }
      if (e) key.e = e;
    }
    keys.push(key);
  }
  if (!shareable) {
    return {
      mode: 'split',
      x: convertScalar(raw, fallback[0], map, tol, 0),
      y: convertScalar(raw, fallback[1], map, tol, 1),
    };
  }
  return { mode: 'vec', a: finish(rest, keys, vecOps, tol / 10) };
}

function rgbOf(v: number | number[] | null | undefined, alpha: number): RGBA {
  return { r: clamp01(dim(v, 0)), g: clamp01(dim(v, 1)), b: clamp01(dim(v, 2)), a: clamp01(alpha) };
}

/** Colour and opacity are two properties in After Effects and one RGBA value here. */
function convertColor(
  color: RawProp | null | undefined,
  opacity: RawProp | null | undefined,
  warn: (message: string) => void,
): Anim<RGBA> {
  const alpha = convertScalar(opacity, 100, (v) => clamp01(v / 100), TOL.unit);
  const restColor = color ? color.v : [0.5, 0.5, 0.5];
  const rest = rgbOf(restColor, alpha.v);

  let colorKeys: Key<RGBA>[] = [];
  if (color && color.s) {
    const values = color.s.v.map((v) => rgbOf(v, 1));
    colorKeys = simplifySamples(sampleTimes(values.length, color.s.dt), values, rgbaOps, TOL.unit);
  } else if (color && color.k && color.k.length > 1 && !color.ex) {
    colorKeys = color.k.map((k, idx) => {
      const key: Key<RGBA> = { t: k.t, v: rgbOf(k.v, 1) };
      if (idx > 0) {
        const prev = color.k![idx - 1]!;
        if (prev.oi === 'h') key.e = { type: 'hold' };
        else if (!(prev.oi === 'l' && k.ii === 'l')) {
          // Colour keys with a speed are sampled by the host, so handles here are flat.
          const out = prev.oi === 'l' ? 0 : clamp01((prev.oe[0]?.i ?? 0) / 100);
          const inn = k.ii === 'l' ? 0 : clamp01((k.ie[0]?.i ?? 0) / 100);
          key.e = { type: 'bezier', x1: round4(out), y1: 0, x2: round4(1 - inn), y2: 1 };
        }
      }
      return key;
    });
    if (keysAreConstant(colorKeys, rgbaOps, 1e-4)) colorKeys = [];
  }

  const alphaAnimated = isAnimated(alpha);
  if (!colorKeys.length && !alphaAnimated) return { v: rest };
  if (!colorKeys.length) {
    return { v: rest, k: alpha.k!.map((k) => ({ ...k, v: rgbOf(restColor, k.v) })) };
  }
  if (alphaAnimated) warn('Colour and opacity are both animated on one paint; the opacity is only matched at the colour keys.');
  return {
    v: rest,
    k: colorKeys.map((k) => ({ ...k, v: { ...k.v, a: evalAnim(alpha, k.t, numOps) } })),
  };
}

function convertTransformProps(
  props: {
    anchor: RawProp | null | undefined;
    position?: RawProp | null;
    positionX?: RawProp | null;
    positionY?: RawProp | null;
    scale: RawProp | null | undefined;
    rotation: RawProp | null | undefined;
    opacity: RawProp | null | undefined;
  },
): Transform {
  const position: AnimVec2 =
    props.positionX || props.positionY
      ? {
          mode: 'split',
          x: convertScalar(props.positionX, 0, identity, TOL.px),
          y: convertScalar(props.positionY, 0, identity, TOL.px),
        }
      : convertVec(props.position, [0, 0], identity, TOL.px, 'spatial');
  return {
    anchor: convertVec(props.anchor, [0, 0], identity, TOL.px, 'spatial'),
    position,
    scale: convertVec(props.scale, [100, 100], (v) => v / 100, TOL.scale, 'multi'),
    rotation: convertScalar(props.rotation, 0, identity, TOL.degrees, 0, true),
    opacity: convertScalar(props.opacity, 100, (v) => clamp01(v / 100), TOL.unit),
  };
}

function identityTransform(): Transform {
  return {
    anchor: staticVec(0, 0),
    position: staticVec(0, 0),
    scale: staticVec(1, 1),
    rotation: { v: 0 },
    opacity: { v: 1 },
  };
}

function isIdentity(t: Transform): boolean {
  const zero = (av: AnimVec2, n: number): boolean =>
    !isAnimVecAnimated(av) &&
    (av.mode === 'vec'
      ? Math.abs(av.a.v.x - n) < 1e-6 && Math.abs(av.a.v.y - n) < 1e-6
      : Math.abs(av.x.v - n) < 1e-6 && Math.abs(av.y.v - n) < 1e-6);
  return (
    zero(t.anchor, 0) &&
    zero(t.position, 0) &&
    zero(t.scale, 1) &&
    !isAnimated(t.rotation) &&
    Math.abs(t.rotation.v) < 1e-6 &&
    !isAnimated(t.opacity) &&
    Math.abs(t.opacity.v - 1) < 1e-6
  );
}

// ------------------------------------------------------------------ shapes

interface Mods {
  fills: RawShapeItem[];
  strokes: RawShapeItem[];
  trim?: RawShapeItem;
  round?: RawShapeItem;
  /** Merge Paths mode of the group itself (1 merge, 2 add, 3 subtract, 4 intersect, 5 exclude). Not passed down. */
  merge?: number;
}

const PATH_LIKE = new Set([
  'ADBE Vector Shape - Rect',
  'ADBE Vector Shape - Ellipse',
  'ADBE Vector Shape - Star',
  'ADBE Vector Shape - Group',
]);

const UNSUPPORTED_SHAPE_ITEMS: Record<string, string> = {
  'ADBE Vector Filter - Repeater': 'Repeater',
  'ADBE Vector Filter - Offset': 'Offset Paths',
  'ADBE Vector Filter - PB': 'Pucker & Bloat',
  'ADBE Vector Filter - Twist': 'Twist',
  'ADBE Vector Filter - Roughen': 'Wiggle Paths',
  'ADBE Vector Filter - Wiggler': 'Wiggle Transform',
  'ADBE Vector Filter - Zigzag': 'Zig Zag',
};

interface ShapeCtx {
  warn: (message: string, level?: 'info' | 'warn') => void;
}

/** Paints and modifiers apply to every outline listed above them, so collect what follows `index`. */
function modsAfter(items: RawShapeItem[], index: number, inherited: Mods, ctx: ShapeCtx): Mods {
  const mods: Mods = { fills: [], strokes: [] };
  for (let j = index + 1; j < items.length; j++) {
    const it = items[j]!;
    switch (it.mn) {
      case 'ADBE Vector Graphic - Fill':
        mods.fills.push(it);
        break;
      case 'ADBE Vector Graphic - Stroke':
        mods.strokes.push(it);
        break;
      case 'ADBE Vector Graphic - G-Fill':
        ctx.warn('Gradient fills cannot be read from After Effects by scripts; a grey fill is used instead.');
        mods.fills.push({ ...it, mn: 'ADBE Vector Graphic - Fill', color: { v: [0.5, 0.5, 0.5, 1] } });
        break;
      case 'ADBE Vector Graphic - G-Stroke':
        ctx.warn('Gradient strokes cannot be read from After Effects by scripts; a grey stroke is used instead.');
        mods.strokes.push({ ...it, mn: 'ADBE Vector Graphic - Stroke', color: { v: [0.5, 0.5, 0.5, 1] } });
        break;
      case 'ADBE Vector Filter - Trim':
        if (!mods.trim) mods.trim = it;
        break;
      case 'ADBE Vector Filter - RC':
        if (!mods.round) mods.round = it;
        break;
      case 'ADBE Vector Filter - Merge':
        if (mods.merge === undefined) mods.merge = Math.round(dim(it.mode?.v, 0)) || 1;
        break;
      default:
        break;
    }
  }
  mods.fills.push(...inherited.fills);
  mods.strokes.push(...inherited.strokes);
  if (!mods.trim && inherited.trim) mods.trim = inherited.trim;
  if (!mods.round && inherited.round) mods.round = inherited.round;
  return mods;
}

function buildStyle(mods: Mods, ctx: ShapeCtx): ShapeStyle {
  const paint = (it: RawShapeItem): Paint => ({ color: convertColor(it.color, it.opacity, ctx.warn) });
  const style: ShapeStyle = { fills: mods.fills.map(paint), strokes: mods.strokes.map(paint) };

  const fill = mods.fills[0];
  if (fill && dim(fill.rule?.v, 0) === 2) style.fillRule = 'evenodd';

  const stroke = mods.strokes[0];
  if (stroke) {
    style.strokeWidth = convertScalar(stroke.width, 1, identity, 0.02);
    const cap = dim(stroke.cap?.v, 0);
    style.cap = cap === 2 ? 'round' : cap === 3 ? 'square' : 'butt';
    const join = dim(stroke.join?.v, 0);
    style.join = join === 2 ? 'round' : join === 3 ? 'bevel' : 'miter';
    if (stroke.miter) style.miterLimit = dim(stroke.miter.v, 0);
    if (stroke.dashes && stroke.dashes.length) {
      const pattern = stroke.dashes.filter((d) => d.mn.indexOf('Offset') === -1).map((d) => d.v);
      if (pattern.length === 1) pattern.push(pattern[0]!);
      if (pattern.length) style.dashes = pattern;
    }
    if (mods.strokes.length > 1) ctx.warn('Several strokes share one weight in Figma; the first stroke width is used.', 'info');
  }

  if (mods.trim) {
    style.trim = {
      start: convertScalar(mods.trim.start, 0, (v) => clamp01(v / 100), TOL.scale),
      end: convertScalar(mods.trim.end, 100, (v) => clamp01(v / 100), TOL.scale),
      offset: convertScalar(mods.trim.offset, 0, (v) => v / 360, TOL.scale),
    };
  }
  if (mods.round) style.cornerRadius = convertScalar(mods.round.radius, 0, identity, TOL.px);
  return style;
}

function rawSubPath(it: RawShapeItem): SubPath | null {
  const p = it.path;
  if (!p || !p.v.length) return null;
  const pair = (a: number[] | undefined): Vec2 => ({ x: a?.[0] ?? 0, y: a?.[1] ?? 0 });
  return { closed: !!p.closed, v: p.v.map(pair), i: p.i.map(pair), o: p.o.map(pair) };
}

function isStaticShape(it: RawShapeItem): boolean {
  switch (it.mn) {
    case 'ADBE Vector Shape - Rect':
      return !isRawAnimated(it.size) && !isRawAnimated(it.pos) && !isRawAnimated(it.round);
    case 'ADBE Vector Shape - Ellipse':
      return !isRawAnimated(it.size) && !isRawAnimated(it.pos);
    default:
      return true;
  }
}

function starPath(it: RawShapeItem, cx: number, cy: number): SubPath {
  return starSubPath({
    polygon: dim(it.starType?.v, 0) === 2,
    points: dim(it.points?.v, 0) || 5,
    cx,
    cy,
    rotation: dim(it.rot?.v, 0),
    outerRadius: dim(it.outer?.v, 0),
    innerRadius: dim(it.inner?.v, 0),
  });
}

/** The outline of a shape at its resting values, in the group's space. */
function restSubPath(it: RawShapeItem): SubPath | null {
  switch (it.mn) {
    case 'ADBE Vector Shape - Rect':
      return rectSubPath(dim(it.pos?.v, 0), dim(it.pos?.v, 1), dim(it.size?.v, 0), dim(it.size?.v, 1), dim(it.round?.v, 0));
    case 'ADBE Vector Shape - Ellipse':
      return ellipseSubPath(dim(it.pos?.v, 0), dim(it.pos?.v, 1), dim(it.size?.v, 0), dim(it.size?.v, 1));
    case 'ADBE Vector Shape - Star':
      return starPath(it, dim(it.pos?.v, 0), dim(it.pos?.v, 1));
    case 'ADBE Vector Shape - Group':
      return rawSubPath(it);
    default:
      return null;
  }
}

function warnStar(it: RawShapeItem, ctx: ShapeCtx): void {
  if (
    isRawAnimated(it.points) ||
    isRawAnimated(it.rot) ||
    isRawAnimated(it.inner) ||
    isRawAnimated(it.outer) ||
    isRawAnimated(it.starType)
  ) {
    ctx.warn(`"${it.name}": animated star/polygon settings are not transferred; the shape at the current frame is used.`);
  }
  if (Math.abs(dim(it.innerRound?.v, 0)) > 0.01 || Math.abs(dim(it.outerRound?.v, 0)) > 0.01) {
    ctx.warn(`"${it.name}": star/polygon roundness is not transferred.`, 'info');
  }
}

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Corner radii: top-left, top-right, bottom-right, bottom-left. */
  r: [number, number, number, number];
}

/**
 * Reads a closed outline as an upright box with rounded corners, if it is
 * one: every point lies on the bounding box, and at each corner the outline
 * leaves both edges at the same distance (that distance is the radius).
 */
export function roundedBox(flat: number[]): Box | null {
  const n = flat.length / 2;
  if (n < 4 || n !== Math.floor(n)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, flat[i * 2]!);
    maxX = Math.max(maxX, flat[i * 2]!);
    minY = Math.min(minY, flat[i * 2 + 1]!);
    maxY = Math.max(maxY, flat[i * 2 + 1]!);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0.01) || !(h > 0.01)) return null;
  const tol = Math.max(0.05, Math.min(w, h) * 0.002);

  // Per edge: how far the nearest point on it stays away from each of its two corners.
  const left = { lo: Infinity, hi: Infinity };
  const right = { lo: Infinity, hi: Infinity };
  const top = { lo: Infinity, hi: Infinity };
  const bottom = { lo: Infinity, hi: Infinity };
  for (let i = 0; i < n; i++) {
    const x = flat[i * 2]!;
    const y = flat[i * 2 + 1]!;
    const onLeft = Math.abs(x - minX) <= tol;
    const onRight = Math.abs(x - maxX) <= tol;
    const onTop = Math.abs(y - minY) <= tol;
    const onBottom = Math.abs(y - maxY) <= tol;
    if (!onLeft && !onRight && !onTop && !onBottom) return null;
    if (onLeft) {
      left.lo = Math.min(left.lo, y - minY);
      left.hi = Math.min(left.hi, maxY - y);
    }
    if (onRight) {
      right.lo = Math.min(right.lo, y - minY);
      right.hi = Math.min(right.hi, maxY - y);
    }
    if (onTop) {
      top.lo = Math.min(top.lo, x - minX);
      top.hi = Math.min(top.hi, maxX - x);
    }
    if (onBottom) {
      bottom.lo = Math.min(bottom.lo, x - minX);
      bottom.hi = Math.min(bottom.hi, maxX - x);
    }
  }
  const corner = (a: number, b: number): number | null => {
    if (!isFinite(a) || !isFinite(b)) return null;
    if (Math.abs(a - b) > Math.max(tol * 4, Math.max(a, b) * 0.03)) return null;
    return Math.max(0, (a + b) / 2);
  };
  const tl = corner(left.lo, top.lo);
  const tr = corner(right.lo, top.hi);
  const br = corner(right.hi, bottom.hi);
  const bl = corner(left.hi, bottom.lo);
  if (tl === null || tr === null || br === null || bl === null) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h, r: [tl, tr, br, bl] };
}

/**
 * A path that changes shape has no keyframe in Figma - unless it stays a
 * rounded box all the way, which is what template rigs for tabs, bars and
 * buttons draw. Then it becomes a rectangle whose size, place and corner
 * radii are animated.
 */
function boxFromSamples(name: string, path: RawShapePath, style: ShapeStyle): Element | null {
  if (!path.s || !path.closed || !path.s.f.length) return null;
  const rest = roundedBox(path.v.flatMap((p) => [p[0] ?? 0, p[1] ?? 0]));
  if (!rest) return null;
  const boxes: Box[] = [];
  for (const frame of path.s.f) {
    const box = roundedBox(frame);
    if (!box) return null;
    boxes.push(box);
  }
  const times = sampleTimes(boxes.length, path.s.dt);
  const vec = (pick: (b: Box) => Vec2, at: Vec2): AnimVec2 => {
    const keys = fitSamples(times, boxes.map(pick), vecOps, TOL.px * FIT);
    return { mode: 'vec', a: keys.length > 1 && !keysAreConstant(keys, vecOps, TOL.px / 10) ? { v: at, k: keys } : { v: at } };
  };
  const num = (pick: (b: Box) => number, at: number): Anim<number> => {
    const keys = fitSamples(times, boxes.map(pick), numOps, TOL.px * FIT);
    return keys.length > 1 && !keysAreConstant(keys, numOps, TOL.px / 10) ? { v: at, k: keys } : { v: at };
  };
  const transform = identityTransform();
  transform.position = vec((b) => ({ x: b.cx, y: b.cy }), { x: rest.cx, y: rest.cy });
  return {
    name,
    transform,
    content: {
      type: 'rect',
      size: vec((b) => ({ x: b.w, y: b.h }), { x: rest.w, y: rest.h }),
      radius: { v: 0 },
      radii: [
        num((b) => b.r[0], rest.r[0]),
        num((b) => b.r[1], rest.r[1]),
        num((b) => b.r[2], rest.r[2]),
        num((b) => b.r[3], rest.r[3]),
      ],
      style,
    },
  };
}

function singleShape(it: RawShapeItem, style: ShapeStyle, ctx: ShapeCtx): Element | null {
  const transform = identityTransform();
  switch (it.mn) {
    case 'ADBE Vector Shape - Rect':
      transform.position = convertVec(it.pos, [0, 0], identity, TOL.px, 'spatial');
      return {
        name: it.name,
        transform,
        content: {
          type: 'rect',
          size: convertVec(it.size, [100, 100], identity, TOL.px, 'multi'),
          radius: convertScalar(it.round, 0, identity, TOL.px),
          style,
        },
      };
    case 'ADBE Vector Shape - Ellipse':
      transform.position = convertVec(it.pos, [0, 0], identity, TOL.px, 'spatial');
      return {
        name: it.name,
        transform,
        content: { type: 'ellipse', size: convertVec(it.size, [100, 100], identity, TOL.px, 'multi'), style },
      };
    case 'ADBE Vector Shape - Star':
      warnStar(it, ctx);
      transform.position = convertVec(it.pos, [0, 0], identity, TOL.px, 'spatial');
      return { name: it.name, transform, content: { type: 'path', paths: [starPath(it, 0, 0)], style } };
    case 'ADBE Vector Shape - Group': {
      const sp = rawSubPath(it);
      if (!sp) return null;
      if (it.path?.anim) {
        const box = boxFromSamples(it.name, it.path, style);
        if (box) return box;
        ctx.warn(`"${it.name}": path shape animation (morphing) has no keyframe in Figma; the shape at the current frame is used.`);
      }
      return { name: it.name, transform, content: { type: 'path', paths: [sp], style } };
    }
    default:
      return null;
  }
}

/**
 * Merge Paths, as far as a winding rule can say it: "Merge" keeps the
 * outlines as they are, "Add" and "Subtract" turn them the way round that
 * fills or empties them, "Exclude Intersections" is the even-odd rule.
 */
function mergedPaths(paths: SubPath[], mode: number, style: ShapeStyle, ctx: ShapeCtx): SubPath[] {
  const turn = (sp: SubPath, clockwise: boolean): SubPath => (signedArea(sp) >= 0 === clockwise ? sp : reversed(sp));
  const first = signedArea(paths[0]!) >= 0;
  switch (mode) {
    case 2:
      style.fillRule = 'nonzero';
      return paths.map((sp) => turn(sp, first));
    case 3:
      style.fillRule = 'nonzero';
      return paths.map((sp, i) => turn(sp, i === 0 ? first : !first));
    case 4:
      ctx.warn('Merge Paths set to "Intersect" is not transferred; the shapes are combined instead.');
      return paths;
    case 5:
      style.fillRule = 'evenodd';
      return paths;
    default:
      return paths;
  }
}

function convertRun(
  run: Array<{ it: RawShapeItem; index: number }>,
  items: RawShapeItem[],
  inherited: Mods,
  ctx: ShapeCtx,
): Element[] {
  const mods = modsAfter(items, run[run.length - 1]!.index, inherited, ctx);
  if (!mods.fills.length && !mods.strokes.length) return [];
  const style = buildStyle(mods, ctx);
  if (run.length > 1 && run.every((r) => isStaticShape(r.it))) {
    // Outlines that share their paints form one compound shape (this is how holes are made).
    let paths: SubPath[] = [];
    for (const r of run) {
      if (r.it.mn === 'ADBE Vector Shape - Star') warnStar(r.it, ctx);
      if (r.it.path?.anim) {
        ctx.warn(`"${r.it.name}": path shape animation (morphing) has no keyframe in Figma; the shape at the current frame is used.`);
      }
      const sp = restSubPath(r.it);
      if (sp) paths.push(sp);
    }
    if (!paths.length) return [];
    if (mods.merge !== undefined) paths = mergedPaths(paths, mods.merge, style, ctx);
    return [{ name: run[0]!.it.name, transform: identityTransform(), content: { type: 'path', paths, style } }];
  }
  const out: Element[] = [];
  for (const r of run) {
    const el = singleShape(r.it, style, ctx);
    if (el) out.push(el);
  }
  return out;
}

function convertShapeItems(items: RawShapeItem[], inherited: Mods, ctx: ShapeCtx): Element[] {
  const out: Element[] = [];
  let run: Array<{ it: RawShapeItem; index: number }> = [];
  const flush = (): void => {
    if (run.length) out.push(...convertRun(run, items, inherited, ctx));
    run = [];
  };
  for (let index = 0; index < items.length; index++) {
    const it = items[index]!;
    if (PATH_LIKE.has(it.mn)) {
      run.push({ it, index });
      continue;
    }
    flush();
    if (it.mn === 'ADBE Vector Group') {
      const mods = modsAfter(items, index, inherited, ctx);
      if (mods.merge !== undefined && mods.merge !== 1) {
        ctx.warn(`"${it.name}": Merge Paths across groups is not transferred; each group keeps its own shape.`);
      }
      const el = convertShapeGroup(it, { ...mods, merge: undefined }, ctx);
      if (el) out.push(el);
    } else if (UNSUPPORTED_SHAPE_ITEMS[it.mn]) {
      ctx.warn(`${UNSUPPORTED_SHAPE_ITEMS[it.mn]} is not transferred.`);
    }
  }
  flush();
  return out;
}

function convertShapeGroup(it: RawShapeItem, mods: Mods, ctx: ShapeCtx): Element | null {
  const children = convertShapeItems(it.items ?? [], mods, ctx);
  if (!children.length) return null;
  const tr = it.tr;
  const transform = tr
    ? convertTransformProps({ anchor: tr.a, position: tr.p, scale: tr.s, rotation: tr.r, opacity: tr.o })
    : identityTransform();
  if (tr && (isRawAnimated(tr.sk) || Math.abs(dim(tr.sk?.v, 0)) > 0.01)) {
    ctx.warn(`"${it.name}": skew is not transferred.`);
  }
  if (children.length === 1 && isIdentity(transform)) {
    return { ...children[0]!, name: it.name };
  }
  return { name: it.name, transform, content: { type: 'group', children } };
}

// -------------------------------------------------------------------- text

function convertText(t: RawText, warn: (message: string, level?: 'info' | 'warn') => void): TextContent {
  const text = t.text.replace(/\r\n?/g, '\n').replace(/\u0003/g, '\n');

  const lines: Array<{ x0: number; y0: number; x1: number; y1: number; index: number }> = [];
  const b = t.baselines ?? [];
  for (let i = 0; i + 3 < b.length; i += 4) {
    const line = { x0: b[i]!, y0: b[i + 1]!, x1: b[i + 2]!, y1: b[i + 3]!, index: i / 4 };
    if ([line.x0, line.y0, line.x1, line.y1].every((n) => isFinite(n) && Math.abs(n) < 1e6)) lines.push(line);
  }

  let lineHeight = 0;
  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i]!.y0 - lines[i - 1]!.y0) / (lines[i]!.index - lines[i - 1]!.index);
    if (gap > 0.5) {
      lineHeight = gap;
      break;
    }
  }
  if (!lineHeight) lineHeight = t.leading && t.leading > 0 ? t.leading : t.size * 1.2;

  const first = lines[0];
  let anchorX = 0;
  if (first) {
    anchorX = t.justify === 'center' ? (first.x0 + first.x1) / 2 : t.justify === 'right' ? first.x1 : first.x0;
  }
  const content: TextContent = {
    type: 'text',
    text,
    fontFamily: t.family || t.font || 'Inter',
    fontStyle: t.style || 'Regular',
    fontSize: t.size || 12,
    align: t.justify,
    tracking: t.tracking || 0,
    lineHeight: round4(lineHeight),
    firstBaseline: { x: round4(anchorX), y: round4(first ? first.y0 : 0) },
  };
  if (t.font) content.postScriptName = t.font;
  if (t.fill) content.fill = rgbOf(t.fill, 1);
  if (t.stroke && (t.strokeWidth ?? 0) > 0) content.stroke = { color: rgbOf(t.stroke, 1), width: t.strokeWidth ?? 1 };
  if (t.box && t.boxSize) {
    const w = t.boxSize[0] ?? 0;
    const h = t.boxSize[1] ?? 0;
    content.box = { x: t.boxPos ? (t.boxPos[0] ?? 0) : -w / 2, y: t.boxPos ? (t.boxPos[1] ?? 0) : -h / 2, w, h };
  }
  if (t.allCaps) content.caps = 'all';
  else if (t.smallCaps) content.caps = 'small';

  if ((t.animators ?? 0) > 0) warn('Text animators (per-character animation) are not transferred.');
  if ((t.textKeys ?? 0) > 1) warn('Keyframed source text is not transferred; the text at the current frame is used.');
  return content;
}

// ------------------------------------------------------------------ layers

const BLEND_MODES = new Set<string>([
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

const VISUAL_TYPES = new Set(['solid', 'footage', 'precomp', 'shape', 'text']);

function isDrawn(l: RawLayer): boolean {
  return VISUAL_TYPES.has(l.type) && !!l.enabled && !l.guide && !l.adjustment && !l.noVideo && !l.skip;
}

function carriesTransform(l: RawLayer): boolean {
  return l.type !== 'camera' && l.type !== 'light' && l.type !== 'other';
}

/**
 * After Effects' Drop Shadow as an offset, a blur and a colour. Direction 0
 * points up and turns clockwise; "softness" is twice the blur radius Figma
 * (and CSS) use.
 */
function shadowOf(fx: RawEffect, warn: (message: string, level?: 'info' | 'warn') => void): DropShadow | null {
  const p = fx.p;
  if (!p) return null;
  const max = fx.omax && fx.omax > 0 ? fx.omax : 255;
  const distance = dim(p.distance?.v, 0);
  const direction = (dim(p.direction?.v, 0) * Math.PI) / 180;
  if ([p.color, p.opacity, p.direction, p.distance, p.softness].some((x) => isRawAnimated(x))) {
    warn(`"${fx.name}": the shadow is animated; it is transferred as it looks at the current frame.`, 'info');
  }
  if (dim(p.only?.v, 0) > 0.5) warn(`"${fx.name}": "Shadow Only" is not transferred; the layer is shown with its shadow.`, 'info');
  return {
    color: rgbOf(p.color?.v, dim(p.opacity?.v, 0) / max),
    offset: { x: round4(Math.sin(direction) * distance), y: round4(-Math.cos(direction) * distance) },
    blur: round4(Math.max(0, dim(p.softness?.v, 0)) / 2),
  };
}

class Converter {
  readonly warnings: Warning[] = [];
  readonly assets = new Map<string, AssetRequest>();
  readonly assetInfo: Record<string, Asset> = {};
  /** Nested compositions that an expression holds on one frame (see pickerSets). */
  readonly frozen = new Set<CompContent>();
  private readonly seen = new Set<string>();
  private readonly dump: RawDump;

  constructor(dump: RawDump) {
    this.dump = dump;
  }

  warn(message: string, level: 'info' | 'warn', comp?: string, layer?: string): void {
    const key = `${comp ?? ''}|${layer ?? ''}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const w: Warning = { level, message };
    if (comp) w.comp = comp;
    if (layer) w.layer = layer;
    this.warnings.push(w);
  }

  comp(raw: RawComp): Comp {
    const byIndex = new Map<number, RawLayer>();
    for (const l of raw.layers) byIndex.set(l.index, l);

    // A layer that is not drawn is still needed when a drawn layer follows
    // its transform or is cut out by it (a track matte).
    const needed = new Set<number>();
    const mattes = new Set<number>();
    const addWithParents = (l: RawLayer): void => {
      needed.add(l.index);
      let parent = l.parent === null ? undefined : byIndex.get(l.parent);
      let guard = 0;
      while (parent && carriesTransform(parent) && guard++ < 200) {
        needed.add(parent.index);
        parent = parent.parent === null ? undefined : byIndex.get(parent.parent);
      }
    };
    for (const l of raw.layers) {
      if (!isDrawn(l)) continue;
      addWithParents(l);
      const matte = l.matte ? byIndex.get(l.matte.i) : undefined;
      if (matte && matte.tr && VISUAL_TYPES.has(matte.type) && !matte.skip) {
        mattes.add(matte.index);
        addWithParents(matte);
      }
    }

    const layers: Layer[] = [];
    for (const l of raw.layers) {
      if (l.type === 'camera' || l.type === 'light') {
        this.warn('Camera and light layers are not transferred.', 'info', raw.name);
        continue;
      }
      if (l.adjustment && l.enabled) {
        this.warn('Adjustment layers are not transferred.', 'warn', raw.name, l.name);
      }
      if (!needed.has(l.index)) continue;
      const layer = this.layer(l, raw, isDrawn(l), mattes, byIndex);
      if (layer) layers.push(layer);
    }

    const bg = raw.bg ?? [0, 0, 0];
    return {
      id: raw.id,
      name: raw.name,
      width: raw.w,
      height: raw.h,
      duration: raw.duration,
      frameRate: raw.frameRate,
      background: rgbOf(bg, 1),
      layers,
    };
  }

  private layer(l: RawLayer, comp: RawComp, drawn: boolean, mattes: Set<number>, byIndex: Map<number, RawLayer>): Layer | null {
    const warn = (message: string, level: 'info' | 'warn' = 'warn'): void => this.warn(message, level, comp.name, l.name);
    const tr = l.tr;
    if (!tr) return null;
    const pictured = drawn || mattes.has(l.index);

    let shadow: DropShadow | null = null;
    if (l.threeD) warn('3D layer: only its 2D position, scale and Z rotation are transferred.');
    if (drawn) {
      if (Math.abs(l.stretch - 100) > 0.01) warn('Time stretch is not transferred; the layer plays at normal speed.');
      if ((l.masks ?? 0) > 0) warn('Layer masks are not transferred yet.');
      const other: string[] = [];
      for (const fx of l.fx ?? []) {
        if (fx.mn === 'ADBE Drop Shadow' && !shadow) shadow = shadowOf(fx, warn);
        else other.push(fx.name);
      }
      if (other.length) warn(`Effects are not transferred (${other.join(', ')}).`);
      if (l.blend === 'other') warn('This blending mode has no match in Figma; Normal is used.', 'info');
    }

    const transform = convertTransformProps({
      anchor: tr.a,
      position: tr.p,
      positionX: tr.px,
      positionY: tr.py,
      scale: tr.s,
      rotation: tr.r,
      opacity: tr.o,
    });

    let content: Content = { type: 'empty', width: l.w || 100, height: l.h || 100 };
    if (pictured) {
      switch (l.type) {
        case 'solid': {
          const footage = l.src ? this.dump.footage[l.src] : undefined;
          content = { type: 'solid', width: l.w || 100, height: l.h || 100, color: rgbOf(footage?.solid ?? [0.5, 0.5, 0.5], 1) };
          break;
        }
        case 'footage': {
          const footage = l.src ? this.dump.footage[l.src] : undefined;
          if (!footage) break;
          const assetId = `img${footage.id}`;
          if (!this.assets.has(assetId)) {
            this.assets.set(assetId, {
              assetId,
              footageId: footage.id,
              name: footage.name,
              file: footage.missing || footage.placeholder ? null : (footage.file ?? null),
              still: !!footage.still,
              time: Math.max(0, this.dump.poster - l.startTime),
            });
            this.assetInfo[assetId] = { id: assetId, name: footage.name, width: footage.w, height: footage.h };
          }
          if (!footage.still) warn('Video and image-sequence footage arrives as a still image of the current frame.');
          if (footage.missing) warn('The source file of this footage is missing.');
          content = { type: 'image', width: footage.w, height: footage.h, assetId };
          break;
        }
        case 'precomp': {
          const nested = l.src ? this.dump.comps[l.src] : undefined;
          if (!nested) break;
          const shown: CompContent = { type: 'comp', compId: nested.id, width: nested.w, height: nested.h, startTime: l.startTime };
          if (l.remap) {
            shown.remap = convertScalar(l.remap, 0, identity, 0.0005);
            if (l.remap.ex && !isAnimated(shown.remap)) this.frozen.add(shown);
          }
          content = shown;
          break;
        }
        case 'shape':
          content = {
            type: 'group',
            children: convertShapeItems(l.shape ?? [], { fills: [], strokes: [] }, {
              warn: (message, level = 'warn') => warn(message, level),
            }),
          };
          break;
        case 'text':
          if (l.text) content = convertText(l.text, warn);
          break;
        default:
          break;
      }
    }

    const layer: Layer = {
      id: String(l.index),
      name: l.name,
      transform,
      content,
      inPoint: Math.min(l.inPoint, l.outPoint),
      outPoint: Math.max(l.inPoint, l.outPoint),
    };
    if (!drawn) layer.hidden = true;
    if (shadow) layer.shadow = shadow;
    if (l.blend && l.blend !== 'normal' && BLEND_MODES.has(l.blend)) layer.blendMode = l.blend as BlendMode;
    if (l.parent !== null) {
      const parent = byIndex.get(l.parent);
      if (parent && parent.tr && carriesTransform(parent)) {
        layer.parentId = String(parent.index);
      } else if (parent) {
        warn('This layer follows a camera or light, which is not transferred; it keeps its own transform only.');
      }
    }
    if (drawn && l.matte) {
      if (!mattes.has(l.matte.i)) {
        warn('The track matte of this layer could not be read; the layer arrives unmasked.');
      } else if (l.matte.t === 'ai' || l.matte.t === 'li') {
        warn('Inverted track mattes have no match in Figma; the layer arrives unmasked.');
      } else {
        layer.matte = { layerId: String(l.matte.i) };
        if (l.matte.t === 'l') layer.matte.luma = true;
      }
    }
    return layer;
  }
}

// ----------------------------------------------------------- template options

/** Figma writes a variant as "Option=Setting, Option=Setting": keep those two characters out of names. */
function plainName(text: string): string {
  return text.replace(/[=,]/g, ' ').replace(/\s+/g, ' ').trim() || '-';
}

function valueKey(v: number | number[] | undefined): string {
  if (v === undefined) return '';
  return (Array.isArray(v) ? v : [v]).map((n) => String(round4(n))).join(' ');
}

function unique(labels: string[], keys: string[]): string[] {
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  return labels.map((l, i) => ((count.get(l) ?? 0) > 1 ? `${l} (${keys[i]})` : l));
}

function shownNames(comp: Comp | undefined): string[] {
  return comp ? comp.layers.filter((l) => !l.hidden).map((l) => l.name) : [];
}

/**
 * The same composition read with different control values (Essential
 * Properties) becomes one set. A setting is named after the layer that only
 * shows with it - that is how a menu saying "4" turns into "Logo Vertical".
 */
function nestedSets(dump: RawDump, comps: Record<string, Comp>): Record<string, CompSet> {
  const groups = new Map<string, RawComp[]>();
  for (const raw of Object.values(dump.comps)) {
    if (!raw.cid || !raw.ep || !comps[raw.id]) continue;
    const list = groups.get(raw.cid);
    if (list) list.push(raw);
    else groups.set(raw.cid, [raw]);
  }

  const sets: Record<string, CompSet> = {};
  for (const [cid, list] of groups) {
    if (list.length < 2) continue;
    const names: string[] = [];
    for (const raw of list) {
      for (const e of raw.ep ?? []) if (e.v !== undefined && !names.includes(e.name)) names.push(e.name);
    }
    const keyOf = (raw: RawComp, name: string): string => valueKey(raw.ep?.find((e) => e.name === name)?.v);

    const props: Array<{ name: string; values: string[]; keys: string[] }> = [];
    for (const name of names) {
      const keys = [...new Set(list.map((raw) => keyOf(raw, name)))];
      if (keys.length < 2) continue;
      if (keys.every((k) => k !== '' && isFinite(Number(k)))) keys.sort((a, b) => Number(a) - Number(b));
      const onOff = keys.length === 2 && keys[0] === '0' && keys[1] === '1';
      const labels = keys.map((key) => {
        const withIt = list.filter((raw) => keyOf(raw, name) === key);
        const without = list.filter((raw) => keyOf(raw, name) !== key);
        const elsewhere = new Set(without.flatMap((raw) => shownNames(comps[raw.id])));
        const own = shownNames(comps[withIt[0]!.id]).filter(
          (n) => !elsewhere.has(n) && withIt.every((raw) => shownNames(comps[raw.id]).includes(n)),
        );
        if (own.length) return plainName(own[0]!);
        if (onOff) return key === '1' ? 'On' : 'Off';
        return plainName(key);
      });
      props.push({ name: plainName(name), values: unique(labels, keys), keys });
    }
    if (!props.length) continue;

    const id = `set${cid}`;
    sets[id] = {
      id,
      name: list[0]!.name,
      props: props.map((p) => ({ name: p.name, values: p.values })),
      variants: list.map((raw) => ({
        compId: raw.id,
        choice: props.map((p) => p.keys.indexOf(keyOf(raw, names.find((n) => plainName(n) === p.name) ?? p.name))),
      })),
    };
  }
  return sets;
}

/** File names and the like, without what only a computer needs. */
function tidyName(name: string): string {
  return name.replace(/\.(png|jpe?g|gif|webp|bmp|tiff?|psd|ai|eps|svg|mov|mp4)$/i, '').replace(/@\dx$/i, '').trim();
}

/** Names nobody chose: "img-3fcac7085ebcb798", "Layer 12", "IMG_2041" ... */
function looksGenerated(name: string): boolean {
  return /[0-9a-f]{8,}/i.test(name) || /^(img|image|layer|dsc|untitled)[\s_-]*\d*$/i.test(name);
}

interface Picker {
  set: CompSet;
  /** When each version shows, in the composition's own time. */
  spans: Array<{ from: number; to: number; index: number }>;
}

/** The versions of a picker composition: the distinct pictures its frames hold. Null when it is not one. */
function pickerOf(nested: Comp | undefined): Picker | null {
  if (!nested) return null;
  const shown = nested.layers.filter((l) => !l.hidden);
  if (shown.length < 2) return null;
  const cuts = [0, nested.duration];
  for (const l of shown) cuts.push(l.inPoint, l.outPoint);
  const times = [...new Set(cuts.filter((t) => t >= 0 && t <= nested.duration).map(round4))].sort((a, b) => a - b);

  const states: Array<{ key: string; ids: string[]; names: string[]; images: boolean; at: number }> = [];
  const spans: Picker['spans'] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const from = times[i]!;
    const to = times[i + 1]!;
    if (to - from < 1e-4) continue;
    const mid = (from + to) / 2;
    const visible = shown.filter((l) => l.inPoint <= mid && mid < l.outPoint);
    if (!visible.length) continue;
    const key = visible.map((l) => l.id).join(',');
    let index = states.findIndex((s) => s.key === key);
    if (index === -1) {
      index = states.length;
      states.push({
        key,
        ids: visible.map((l) => l.id),
        names: visible.map((l) => l.name),
        images: visible.every((l) => l.content.type === 'image'),
        // Well inside the frame, so nothing depends on which side of a frame edge a number falls.
        at: from + Math.min((to - from) / 2, 0.5 / Math.max(1, nested.frameRate)),
      });
    }
    spans.push({ from, to, index });
  }
  if (states.length < 2 || states.length > 64) return null;

  // Every version needs a layer of its own - otherwise this is an ordinary animation held on a
  // frame (layers coming in one after the other), not a set of alternatives.
  const own = states.map((s, i) => s.ids.findIndex((id) => states.every((o, j) => j === i || !o.ids.includes(id))));
  if (own.some((at) => at === -1)) return null;
  const names = states.map((s, i) => tidyName(s.names[own[i]!]!));
  const numbered = names.some(looksGenerated) || new Set(names).size < names.length;

  return {
    set: {
      id: `pick${nested.id}`,
      name: nested.name,
      props: [{ name: states.every((s) => s.images) ? 'Image' : 'Version', values: numbered ? names.map((_, i) => String(i + 1)) : names.map(plainName) }],
      variants: states.map((s, i) => ({ compId: nested.id, choice: [i], at: round4(s.at) })),
    },
    spans,
  };
}

/**
 * A nested composition that an expression holds on one frame is a picker:
 * each of its frames holds another picture (an image per frame, say) and a
 * control on the layer decides which one shows. All of them go across, as the
 * versions of one set, and the layer shows the one that is picked now - so
 * the choice can be made again in Figma.
 */
function pickerSets(converter: Converter, comps: Record<string, Comp>, sets: Record<string, CompSet>, taken: Map<string, CompSet>): void {
  const known = new Map<string, Picker | null>();
  for (const comp of Object.values(comps)) {
    for (const layer of comp.layers) {
      const c = layer.content;
      if (c.type !== 'comp' || !converter.frozen.has(c) || taken.has(c.compId)) continue;
      let picker = known.get(c.compId);
      if (picker === undefined) {
        picker = pickerOf(comps[c.compId]);
        known.set(c.compId, picker);
        if (picker) sets[picker.set.id] = picker.set;
      }
      if (!picker) continue;
      const t = c.remap?.v ?? 0;
      const span = picker.spans.find((s) => t >= s.from - 1e-5 && t < s.to - 1e-5);
      if (!span) continue;
      c.setId = picker.set.id;
      c.variant = span.index;
    }
  }
}

/** The settings a nested set shows for one of its versions, as text. */
function variantLabel(set: CompSet, compId: string): string {
  const variant = set.variants.find((v) => v.compId === compId);
  if (!variant) return '';
  return set.props.map((p, i) => p.values[variant.choice[i] ?? 0] ?? '').join(' / ');
}

/**
 * Template options of the root composition. The layers that react to the
 * options (with everything stacked between them) are lifted out into a
 * composition of their own, read once per setting: in Figma that is one
 * component with the options as its properties, sitting in the frame next to
 * the layers that never change.
 */
function rootOptions(
  dump: RawDump,
  converter: Converter,
  comps: Record<string, Comp>,
  sets: Record<string, CompSet>,
  setOfComp: Map<string, CompSet>,
): void {
  const states = dump.states ?? [];
  const controllers: RawController[] = dump.controllers ?? [];
  const base = dump.base ?? [];
  const rawRoot = dump.comps[dump.rootId];
  const root = comps[dump.rootId];
  if (!states.length || !controllers.length || !rawRoot || !root) return;

  // Layers that look different in some setting. A layer that is never drawn (the
  // guide layer holding the controls, say) does not count, or it would drag
  // everything stacked between it and the real layers into the component.
  const drawnAtFirst = new Set(rawRoot.layers.filter(isDrawn).map((l) => l.index));
  const changed = new Set<number>();
  for (const st of states) for (const l of st.layers) if (l && (isDrawn(l) || drawnAtFirst.has(l.index))) changed.add(l.index);
  if (!changed.size) {
    converter.warn('The chosen template options do not change anything in this composition.', 'info', rawRoot.name);
    return;
  }

  // Grow the range until no parent link or track matte crosses its border.
  let lo = Math.min(...changed);
  let hi = Math.max(...changed);
  const everyLayer: RawLayer[] = [...rawRoot.layers];
  for (const st of states) for (const l of st.layers) if (l) everyLayer.push(l);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of everyLayer) {
      const inside = l.index >= lo && l.index <= hi;
      for (const other of [l.parent, l.matte?.i]) {
        if (typeof other !== 'number') continue;
        if ((other >= lo && other <= hi) !== inside) {
          lo = Math.min(lo, l.index, other);
          hi = Math.max(hi, l.index, other);
          grew = true;
        }
      }
    }
  }
  const inRange = (l: Layer): boolean => Number(l.id) >= lo && Number(l.id) <= hi;

  const layerNames = [...new Set(controllers.map((c) => c.layer))];
  const setName = layerNames.length === 1 ? layerNames[0]! : `${rawRoot.name} options`;
  const setId = `set${dump.rootId}@`;

  const all = [{ values: base, layers: [] as Array<RawLayer | null> }, ...states];
  all.sort((a, b) => {
    for (let i = 0; i < a.values.length; i++) if (a.values[i] !== b.values[i]) return (a.values[i] ?? 0) - (b.values[i] ?? 0);
    return 0;
  });
  const compIdOf = (values: number[]): string => `${dump.rootId}@${values.join('.')}`;
  for (const st of all) {
    const swapped = new Map<number, RawLayer>();
    for (const l of st.layers) if (l) swapped.set(l.index, l);
    const converted = converter.comp({ ...rawRoot, layers: rawRoot.layers.map((l) => swapped.get(l.index) ?? l) });
    const id = compIdOf(st.values);
    comps[id] = { ...converted, id, name: setName, layers: converted.layers.filter(inRange) };
  }

  // Name each setting after what it switches further down (a market after its end card, say).
  const props = controllers.map((c, ci) => {
    const keys: string[] = [];
    const alone: string[][] = [];
    for (let x = c.min; x <= c.max; x++) {
      keys.push(String(x));
      const values = base.map((b, i) => (i === ci ? x : b));
      const comp = comps[compIdOf(values)];
      alone.push(
        (comp?.layers ?? []).map((l) => {
          const set = l.content.type === 'comp' ? setOfComp.get(l.content.compId) : undefined;
          return set && l.content.type === 'comp' ? `${l.id}\n${variantLabel(set, l.content.compId)}` : '';
        }),
      );
    }
    const perLayer = new Map<string, string[]>();
    alone.forEach((entries, option) => {
      for (const entry of entries) {
        if (!entry) continue;
        const [layerId, label] = entry.split('\n') as [string, string];
        const list = perLayer.get(layerId) ?? keys.map(() => '');
        list[option] = label;
        perLayer.set(layerId, list);
      }
    });
    let best: string[] | null = null;
    let bestCount = 1;
    for (const labels of perLayer.values()) {
      const count = new Set(labels.filter((l) => l)).size;
      if (count > bestCount) {
        best = labels;
        bestCount = count;
      }
    }
    // Failing that, after a layer that only shows with this setting.
    const shown = keys.map((_, option) => shownNames(comps[compIdOf(base.map((b, i) => (i === ci ? c.min + option : b)))]));
    const own = keys.map(
      (_, option) => shown[option]!.find((n) => shown.every((list, other) => other === option || !list.includes(n))) ?? '',
    );
    // Whichever of the two tells more settings apart goes first.
    const ownFirst = new Set(own.filter((n) => n)).size > bestCount;
    const onOff = c.min === 0 && c.max === 1;
    const labels = keys.map((key, option) => {
      const nested = best?.[option] ?? '';
      const found = ownFirst ? own[option] || nested : nested || own[option];
      if (found) return plainName(found);
      if (onOff) return key === '1' ? 'On' : 'Off';
      return key;
    });
    return { name: plainName(c.name), values: unique(labels, keys) };
  });

  sets[setId] = {
    id: setId,
    name: setName,
    props,
    variants: all.map((st) => ({ compId: compIdOf(st.values), choice: st.values.map((v, i) => v - controllers[i]!.min) })),
  };

  const holder: Layer = {
    id: 'options',
    name: setName,
    transform: identityTransform(),
    content: { type: 'comp', compId: compIdOf(base), width: root.width, height: root.height, startTime: 0 },
    inPoint: 0,
    outPoint: root.duration,
  };
  const outside = root.layers.filter((l) => !inRange(l));
  const at = outside.findIndex((l) => Number(l.id) > hi);
  outside.splice(at === -1 ? outside.length : at, 0, holder);
  root.layers = outside;
}

export function convertAeDump(dump: RawDump): ConvertResult {
  const converter = new Converter(dump);
  for (const w of dump.warnings) converter.warn(w.message, 'warn', w.comp, w.layer);
  for (const st of dump.states ?? []) for (const w of st.warnings ?? []) converter.warn(w.message, 'warn', w.comp, w.layer);

  const comps: Record<string, Comp> = {};
  for (const id of Object.keys(dump.comps)) comps[id] = converter.comp(dump.comps[id]!);

  const sets = nestedSets(dump, comps);
  const setOfComp = new Map<string, CompSet>();
  const index = (): void => {
    for (const set of Object.values(sets)) for (const v of set.variants) setOfComp.set(v.compId, set);
  };
  index();
  rootOptions(dump, converter, comps, sets, setOfComp);
  index();

  for (const comp of Object.values(comps)) {
    for (const layer of comp.layers) {
      if (layer.content.type !== 'comp') continue;
      const set = setOfComp.get(layer.content.compId);
      if (set) layer.content.setId = set.id;
    }
  }
  pickerSets(converter, comps, sets, setOfComp);

  const doc: BridgeDoc = {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    source: { app: 'after-effects', version: dump.ae },
    rootCompId: dump.rootId,
    posterTime: dump.poster,
    comps,
    assets: converter.assetInfo,
    warnings: converter.warnings,
  };
  if (Object.keys(sets).length) doc.sets = sets;
  if (dump.project) doc.source.project = dump.project;
  return { doc, assets: [...converter.assets.values()] };
}

/** Puts the answers of the host's beginExport and exportState calls together into one read-out. */
export function mergeDump(base: RawDump, parts: Array<NonNullable<RawDump['states']>[number]>): RawDump {
  const out: RawDump = { ...base, comps: { ...base.comps }, footage: { ...base.footage }, warnings: [...base.warnings], states: [] };
  delete out.pending;
  for (const part of parts) {
    Object.assign(out.comps, part.comps ?? {});
    Object.assign(out.footage, part.footage ?? {});
    out.states!.push({ index: part.index, values: part.values, layers: part.layers, warnings: part.warnings ?? [] });
  }
  return out;
}
