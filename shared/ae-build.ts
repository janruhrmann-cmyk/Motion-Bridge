/**
 * Figma -> After Effects: turns a bridge document into a build plan that
 * host.jsx carries out step by step.
 *
 * This is ae-convert.ts the other way round, and split the same way: all the
 * thinking happens here, where it can be type-checked and tested, and the
 * After Effects script only does what the plan says - add this layer, set
 * that property, put these keys on it. Values in the plan are already in
 * After Effects' own units (percent, degrees, speed and influence per key
 * side) and properties are named by their match names.
 *
 * A key's easing is stored the way After Effects stores it, and the way
 * host.jsx reports it when reading (RawKey in ae-raw.ts), so a composition
 * that is built from a plan and read back gives the same document again.
 */
import type {
  Anim,
  AnimVec2,
  BridgeDoc,
  Comp,
  Content,
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
import type { RawEase } from './ae-raw.ts';
import type { Ops } from './anim.ts';
import { easePiece, easeProgress, evalAnimVec, evalKeys, fitSamples, numOps, splitEase, vecOps } from './anim.ts';
import { cornersSubPath } from './geometry.ts';

export interface PlanKey {
  t: number;
  v: number | number[];
  /** In / out interpolation: linear, bezier, hold. */
  ii: 'l' | 'b' | 'h';
  oi: 'l' | 'b' | 'h';
  /** Speed and influence per dimension (one entry for values that ease as a whole: positions, colours). */
  ie: RawEase[];
  oe: RawEase[];
}

export interface PlanProp {
  v: number | number[];
  k?: PlanKey[];
}

/** A property, by match name, and what it is set to. */
export type PlanSetting = [string, PlanProp];

export interface PlanPath {
  closed: 0 | 1;
  v: number[][];
  i: number[][];
  o: number[][];
}

/** One entry of a shape layer's contents. */
export interface PlanShape {
  mn: string;
  name: string;
  set?: PlanSetting[];
  /** A group's contents, front-most first. */
  items?: PlanShape[];
  /** A group's own transform. */
  tr?: PlanSetting[];
  path?: PlanPath;
  dashes?: number[];
}

export interface PlanText {
  /** Lines are separated by "\r", as After Effects wants them. */
  text: string;
  /** PostScript name when the document knows it; otherwise After Effects looks the font up by family and style. */
  font: string;
  family: string;
  style: string;
  size: number;
  fill: number[] | null;
  stroke: number[] | null;
  strokeWidth: number;
  justify: 'left' | 'center' | 'right' | 'justify';
  tracking: number;
  leading: number;
  caps: '' | 'all' | 'small';
  /** Paragraph text: the box (x, y, width, height) in the layer content's space. */
  box: number[] | null;
  /** Point text: where the first baseline is pinned, in the layer content's space. */
  origin: number[];
  /** Where the glyphs should end up (x, y, width, height); when present the text is lined up with it. */
  ink: number[] | null;
}

export type PlanLayerType = 'shape' | 'text' | 'null' | 'solid' | 'image' | 'comp';

export interface PlanLayer {
  id: string;
  name: string;
  type: PlanLayerType;
  parent?: string;
  matte?: { id: string; luma?: 1; inverted?: 1 };
  /** Not drawn itself (a matte, or a layer others only follow). */
  off?: 1;
  blend?: string;
  /** Present when the layer is not there for the whole composition. */
  span?: [number, number];
  tr: PlanSetting[];
  /** Position is animated per axis ("Separate Dimensions"). */
  sep?: 1;
  shape?: PlanShape[];
  text?: PlanText;
  solid?: { w: number; h: number; color: number[] };
  /** A null object's size (only a visual hint). */
  size?: [number, number];
  image?: { footage: string };
  comp?: { id: string; start: number; remap?: PlanProp };
  shadow?: { color: number[]; opacity: number; direction: number; distance: number; softness: number };
}

export interface PlanComp {
  id: string;
  name: string;
  w: number;
  h: number;
  duration: number;
  frameRate: number;
  bg: number[];
  /** Front-most first. */
  layers: PlanLayer[];
}

export interface PlanFootage {
  id: string;
  name: string;
  file: string;
  w: number;
  h: number;
}

export interface BuildPlan {
  name: string;
  /** The composition the document is about; the others are nested in it. */
  root: string;
  /** Nested compositions come before the ones that use them. */
  comps: PlanComp[];
  footage: PlanFootage[];
  /** Project folder for everything but the root composition. */
  folder: string;
}

export interface BuildOptions {
  /** Used where the document has no timing of its own (a still Figma frame). */
  frameRate: number;
  duration: number;
  /** Where each image of the document is on disk, by asset id. */
  files: Record<string, string>;
}

export interface PlanResult {
  plan: BuildPlan;
  warnings: Warning[];
}

const r5 = (n: number): number => (isFinite(n) ? Math.round(n * 100000) / 100000 : 0);
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const pct = (v: number): number => v * 100;
const same = (v: number): number => v;

/** A key side that does not bend the curve; After Effects wants one for every side. */
const flat = (): RawEase => ({ s: 0, i: 16.667 });
const influence = (fraction: number): number => r5(Math.max(0.1, Math.min(100, fraction * 100)));

// ------------------------------------------------------------------ keys

/** One axis of a value on a shared list of key times: its values there, and the ease of each step. */
interface Track {
  v: number[];
  /** e[i] carries the value from time i-1 to time i. */
  e: Array<Ease | undefined>;
}

function unionTimes(lists: Array<Key<unknown>[] | undefined>): number[] {
  const times: number[] = [];
  for (const keys of lists) for (const k of keys ?? []) times.push(k.t);
  times.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) {
    if (!out.length || t - out[out.length - 1]! > 1e-6) out.push(t);
  }
  return out;
}

/**
 * The ease of the part of a step between progress p0 and p1. A piece of an
 * eased step is an eased step again - except where the whole has handles that
 * reach so far that the piece's would leave its box (an influence above
 * 100 %, which After Effects does not have). Then the piece is fitted with the
 * closest ease there is, and when none is close, `cuts` says where to cut it
 * (as progress within the whole step) so that every part can be fitted.
 */
function pieceEase(e: Ease | undefined, p0: number, p1: number): { e: Ease | undefined; cuts: number[] } {
  if (p0 < 1e-6 && p1 > 1 - 1e-6) return { e, cuts: [] };
  if (!e || e.type !== 'bezier') return { e: splitEase(e, p0, p1), cuts: [] };
  const exact = easePiece(e, p0, p1);
  if (!exact) return { e: undefined, cuts: [] };
  if (exact.x1 > -0.004 && exact.x1 < 1.004 && exact.x2 > -0.004 && exact.x2 < 1.004) return { e: splitEase(e, p0, p1), cuts: [] };
  const from = easeProgress(e, p0);
  const span = easeProgress(e, p1) - from;
  const steps = 48;
  const at: number[] = [];
  const values: number[] = [];
  for (let i = 0; i <= steps; i++) {
    at.push(i / steps);
    values.push((easeProgress(e, p0 + ((p1 - p0) * i) / steps) - from) / span);
  }
  const fitted = fitSamples(at, values, numOps, 0.002);
  if (fitted.length === 2) return { e: fitted[1]!.e, cuts: [] };
  if (fitted.length < 2) return { e: undefined, cuts: [] };
  return { e: splitEase(e, p0, p1), cuts: fitted.slice(1, -1).map((k) => p0 + (p1 - p0) * k.t) };
}

/**
 * A value's keys carried onto other key times without changing its motion.
 * `cuts` collects the times at which more keys are needed for that (see
 * pieceEase).
 */
function onTimes(keys: Key<number>[] | undefined, rest: number, times: number[], cuts: number[] = []): Track {
  const track: Track = { v: [], e: [] };
  if (!keys || !keys.length) {
    for (let i = 0; i < times.length; i++) {
      track.v.push(rest);
      track.e.push(undefined);
    }
    return track;
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    track.v.push(evalKeys(keys, t, numOps));
    if (i === 0) {
      track.e.push(undefined);
      continue;
    }
    const from = times[i - 1]!;
    // The step of the value's own keys this stretch lies in.
    let hit = -1;
    for (let j = 1; j < keys.length; j++) {
      if (keys[j - 1]!.t <= from + 1e-6 && keys[j]!.t >= t - 1e-6) {
        hit = j;
        break;
      }
    }
    if (hit < 0) {
      track.e.push(undefined);
      continue;
    }
    const a = keys[hit - 1]!;
    const b = keys[hit]!;
    const span = b.t - a.t;
    const piece = pieceEase(b.e, span > 0 ? (from - a.t) / span : 0, span > 0 ? (t - a.t) / span : 1);
    track.e.push(piece.e);
    for (const p of piece.cuts) cuts.push(a.t + span * p);
  }
  return track;
}

/** The two sides of one step, in After Effects' terms, for a value that travels `delta` in `duration` seconds. */
function sides(e: Ease | undefined, delta: number, duration: number): { oi: 'l' | 'b' | 'h'; ii: 'l' | 'b'; oe: RawEase; ie: RawEase } {
  const average = duration > 0 ? delta / duration : 0;
  const straight = (): RawEase => ({ s: r5(average), i: 16.667 });
  if (e && e.type === 'hold') return { oi: 'h', ii: 'l', oe: flat(), ie: flat() };
  if (!e || e.type !== 'bezier') return { oi: 'l', ii: 'l', oe: straight(), ie: straight() };
  // A handle that lies on the corner of the box is what After Effects calls a linear side.
  const outLinear = e.x1 < 1e-4 && Math.abs(e.y1) < 1e-4;
  const inLinear = e.x2 > 1 - 1e-4 && Math.abs(e.y2 - 1) < 1e-4;
  const x1 = Math.max(0.001, e.x1);
  const reach = Math.max(0.001, 1 - e.x2);
  return {
    oi: outLinear ? 'l' : 'b',
    ii: inLinear ? 'l' : 'b',
    oe: outLinear ? straight() : { s: r5((average * e.y1) / x1), i: influence(x1) },
    ie: inLinear ? straight() : { s: r5((average * (1 - e.y2)) / reach), i: influence(reach) },
  };
}

/**
 * Keys for After Effects from one or more axes on shared times. `whole`
 * values (positions, colours) ease as one, along the way they travel; the
 * others carry an ease per axis.
 */
function planKeys(times: number[], tracks: Track[], whole: boolean, pack: (values: number[]) => number | number[]): PlanKey[] {
  const count = whole ? 1 : tracks.length;
  const keys: PlanKey[] = times.map((t, i) => ({
    t: r5(t),
    v: pack(tracks.map((tr) => tr.v[i]!)),
    ii: 'l',
    oi: 'l',
    ie: Array.from({ length: count }, flat),
    oe: Array.from({ length: count }, flat),
  }));
  for (let i = 1; i < times.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    const duration = times[i]! - times[i - 1]!;
    if (whole) {
      const path = Math.hypot(...tracks.map((tr) => tr.v[i]! - tr.v[i - 1]!));
      const s = sides(tracks[0]!.e[i], path, duration);
      a.oi = s.oi;
      b.ii = s.ii;
      a.oe = [s.oe];
      b.ie = [s.ie];
      continue;
    }
    const each = tracks.map((tr) => sides(tr.e[i], tr.v[i]! - tr.v[i - 1]!, duration));
    // A key has one interpolation type for all its axes. A linear side written as a bezier is the same line.
    const moving = each.filter((s, d) => Math.abs(tracks[d]!.v[i]! - tracks[d]!.v[i - 1]!) > 1e-9);
    const judged = moving.length ? moving : each;
    a.oi = judged.every((s) => s.oi === 'h') ? 'h' : judged.some((s) => s.oi === 'b') ? 'b' : 'l';
    b.ii = judged.some((s) => s.ii === 'b') ? 'b' : 'l';
    a.oe = each.map((s) => s.oe);
    b.ie = each.map((s) => s.ie);
  }
  return keys;
}

/**
 * After Effects has no spring: a spring step becomes the eased steps that
 * follow the same curve.
 */
function noSprings<T>(keys: Key<T>[] | undefined, ops: Ops<T>, fps: number): Key<T>[] | undefined {
  if (!keys || !keys.some((k) => k.e && k.e.type === 'spring')) return keys;
  const out: Key<T>[] = [];
  keys.forEach((k, idx) => {
    const prev = keys[idx - 1];
    if (!prev || !k.e || k.e.type !== 'spring') {
      out.push(k);
      return;
    }
    const span = k.t - prev.t;
    const steps = Math.max(2, Math.round(span * Math.max(fps, 30)));
    const times: number[] = [];
    const values: T[] = [];
    for (let i = 0; i <= steps; i++) {
      times.push(prev.t + (span * i) / steps);
      values.push(i === steps ? k.v : ops.lerp(prev.v, k.v, easeProgress(k.e, i / steps)));
    }
    const fitted = fitSamples(times, values, ops, Math.max(1e-4, ops.dist(prev.v, k.v) / 400));
    if (fitted.length < 2) out.push({ t: k.t, v: k.v });
    else out.push(...fitted.slice(1));
  });
  return out;
}

function scalarProp(anim: Anim<number>, map: (v: number) => number, fps: number): PlanProp {
  const keys = noSprings(anim.k, numOps, fps);
  if (!keys || keys.length < 2) return { v: r5(map(keys && keys.length ? keys[0]!.v : anim.v)) };
  const times = unionTimes([keys]);
  const track = onTimes(keys.map((k) => ({ ...k, v: map(k.v) })), map(anim.v), times);
  return { v: r5(map(anim.v)), k: planKeys(times, [track], false, (v) => r5(v[0]!)) };
}

/** Sampled once per frame and fitted again: for motion After Effects cannot take over key by key. */
function resampled(av: AnimVec2, fps: number): Anim<Vec2> {
  const rest = evalAnimVec(av, 0);
  const lists = av.mode === 'vec' ? [av.a.k] : [av.x.k, av.y.k];
  const all = unionTimes(lists);
  if (all.length < 2) return { v: av.mode === 'vec' ? av.a.v : { x: av.x.v, y: av.y.v } };
  const t0 = all[0]!;
  const t1 = all[all.length - 1]!;
  const steps = Math.max(1, Math.round((t1 - t0) * Math.max(fps, 30)));
  const times: number[] = [];
  const values: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    times.push(t);
    values.push(evalAnimVec(av, t));
  }
  const keys = fitSamples(times, values, vecOps, 0.05);
  return keys.length ? { v: rest, k: keys } : { v: rest };
}

/**
 * A two-axis value. `spatial`: a position, which After Effects eases along
 * its path with one curve and does not let the axes go their own way.
 */
function vecProp(av: AnimVec2, map: (v: number) => number, spatial: boolean, fps: number): PlanProp {
  const pack = (v: number[]): number[] => [r5(v[0]!), r5(v[1]!)];
  let source = av;
  if (spatial && av.mode === 'split' && (av.x.k?.length ?? 0) + (av.y.k?.length ?? 0) > 0) source = { mode: 'vec', a: resampled(av, fps) };
  if (source.mode === 'vec') {
    const keys = noSprings(source.a.k, vecOps, fps);
    const rest = source.a.v;
    if (!keys || keys.length < 2) {
      const v = keys && keys.length ? keys[0]!.v : rest;
      return { v: pack([map(v.x), map(v.y)]) };
    }
    const times = unionTimes([keys]);
    const x = onTimes(keys.map((k) => ({ ...k, v: map(k.v.x) })), map(rest.x), times);
    const y = onTimes(keys.map((k) => ({ ...k, v: map(k.v.y) })), map(rest.y), times);
    return { v: pack([map(rest.x), map(rest.y)]), k: planKeys(times, [x, y], spatial, pack) };
  }
  const xk = noSprings(source.x.k, numOps, fps);
  const yk = noSprings(source.y.k, numOps, fps);
  const rest = [map(source.x.v), map(source.y.v)];
  let times = unionTimes([xk, yk]);
  if (times.length < 2) return { v: pack(rest) };
  const mx = xk?.map((k) => ({ ...k, v: map(k.v) }));
  const my = yk?.map((k) => ({ ...k, v: map(k.v) }));
  // The axes have keys of their own here, After Effects has one set for both. Where a step has to be
  // cut for that and its pieces cannot be held exactly, more keys are added until they can.
  for (let round = 0; ; round++) {
    const cuts: number[] = [];
    const x = onTimes(mx, rest[0]!, times, cuts);
    const y = onTimes(my, rest[1]!, times, cuts);
    if (!cuts.length || round === 4) return { v: pack(rest), k: planKeys(times, [x, y], false, pack) };
    times = unionTimes([times.map((t) => ({ t, v: 0 })), cuts.map((t) => ({ t, v: 0 }))]);
  }
}

/** One RGBA value here is two properties in After Effects: a colour and an opacity. */
function colorProps(anim: Anim<RGBA>, fps: number): { color: PlanProp; opacity: PlanProp } {
  const rgb = (c: RGBA): number[] => [r5(clamp01(c.r)), r5(clamp01(c.g)), r5(clamp01(c.b)), 1];
  const opacity = scalarProp({ v: anim.v.a, k: anim.k?.map((k) => ({ ...k, v: k.v.a })) }, (v) => pct(clamp01(v)), fps);
  if (opacity.k && opacity.k.every((k) => Math.abs((k.v as number) - (opacity.k![0]!.v as number)) < 1e-6)) delete opacity.k;
  const keys = anim.k;
  const moves = !!keys && keys.length > 1 && keys.some((k) => Math.max(Math.abs(k.v.r - keys[0]!.v.r), Math.abs(k.v.g - keys[0]!.v.g), Math.abs(k.v.b - keys[0]!.v.b)) > 1e-6);
  if (!keys || !moves) return { color: { v: rgb(anim.v) }, opacity };
  const out: PlanKey[] = keys.map((k) => ({ t: r5(k.t), v: rgb(k.v), ii: 'l', oi: 'l', ie: [flat()], oe: [flat()] }));
  for (let i = 1; i < keys.length; i++) {
    const e = keys[i]!.e;
    const a = out[i - 1]!;
    const b = out[i]!;
    if (e && e.type === 'hold') a.oi = 'h';
    else if (e && (e.type === 'bezier' || e.type === 'spring')) {
      // Colours ease with flat handles (their "speed" has no unit worth converting); how far the handles reach is kept.
      const x1 = e.type === 'bezier' ? e.x1 : 0.3;
      const x2 = e.type === 'bezier' ? e.x2 : 0.2;
      a.oi = 'b';
      b.ii = 'b';
      a.oe = [{ s: 0, i: influence(x1) }];
      b.ie = [{ s: 0, i: influence(1 - x2) }];
    }
  }
  return { color: { v: rgb(anim.v), k: out }, opacity };
}

const fixed = (v: number | number[]): PlanProp => ({ v });

// ------------------------------------------------------------------ shapes

function pathOf(sp: SubPath): PlanPath {
  const list = (pts: Vec2[]): number[][] => sp.v.map((_, j) => [r5(pts[j]?.x ?? 0), r5(pts[j]?.y ?? 0)]);
  return { closed: sp.closed ? 1 : 0, v: list(sp.v), i: list(sp.i), o: list(sp.o) };
}

const CAPS = { butt: 1, round: 2, square: 3 } as const;
const JOINS = { miter: 1, round: 2, bevel: 3 } as const;

class Planner {
  readonly warnings: Warning[] = [];
  private readonly seen = new Set<string>();
  private fps = 30;
  private where = { comp: '', layer: '' };
  private readonly doc: BridgeDoc;
  private readonly opts: BuildOptions;

  constructor(doc: BridgeDoc, opts: BuildOptions) {
    this.doc = doc;
    this.opts = opts;
  }

  private warn(message: string, level: 'info' | 'warn' = 'warn'): void {
    const key = `${this.where.comp}|${this.where.layer}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const w: Warning = { level, message };
    if (this.where.comp) w.comp = this.where.comp;
    if (this.where.layer) w.layer = this.where.layer;
    this.warnings.push(w);
  }

  private paints(style: ShapeStyle): PlanShape[] {
    const items: PlanShape[] = [];
    if (style.cornerRadius && (style.cornerRadius.k || style.cornerRadius.v > 1e-6)) {
      items.push({ mn: 'ADBE Vector Filter - RC', name: 'Round Corners', set: [['ADBE Vector RoundCorner Radius', scalarProp(style.cornerRadius, same, this.fps)]] });
    }
    if (style.trim) {
      items.push({
        mn: 'ADBE Vector Filter - Trim',
        name: 'Trim Paths',
        set: [
          ['ADBE Vector Trim Start', scalarProp(style.trim.start, pct, this.fps)],
          ['ADBE Vector Trim End', scalarProp(style.trim.end, pct, this.fps)],
          ['ADBE Vector Trim Offset', scalarProp(style.trim.offset, (v) => v * 360, this.fps)],
        ],
      });
    }
    // After Effects draws what is higher in the list on top; a stroke lies over its fill.
    style.strokes.forEach((p: Paint, index) => {
      const { color, opacity } = colorProps(p.color, this.fps);
      const set: PlanSetting[] = [
        ['ADBE Vector Stroke Color', color],
        ['ADBE Vector Stroke Opacity', opacity],
        ['ADBE Vector Stroke Width', scalarProp(style.strokeWidth ?? { v: 1 }, (v) => Math.max(0, v), this.fps)],
        ['ADBE Vector Stroke Line Cap', fixed(CAPS[style.cap ?? 'butt'])],
        ['ADBE Vector Stroke Line Join', fixed(JOINS[style.join ?? 'miter'])],
      ];
      if (style.miterLimit !== undefined) set.push(['ADBE Vector Stroke Miter Limit', fixed(Math.max(1, style.miterLimit))]);
      const item: PlanShape = { mn: 'ADBE Vector Graphic - Stroke', name: style.strokes.length > 1 ? `Stroke ${index + 1}` : 'Stroke', set };
      if (style.dashes && style.dashes.length) item.dashes = style.dashes.slice(0, 6).map((d) => Math.max(0, r5(d)));
      items.push(item);
    });
    style.fills.forEach((p: Paint, index) => {
      const { color, opacity } = colorProps(p.color, this.fps);
      const set: PlanSetting[] = [
        ['ADBE Vector Fill Color', color],
        ['ADBE Vector Fill Opacity', opacity],
      ];
      if (style.fillRule === 'evenodd') set.push(['ADBE Vector Fill Rule', fixed(2)]);
      items.push({ mn: 'ADBE Vector Graphic - Fill', name: style.fills.length > 1 ? `Fill ${index + 1}` : 'Fill', set });
    });
    return items;
  }

  /** What draws `c` inside the group it sits in. */
  private contentItems(name: string, c: Content): PlanShape[] {
    switch (c.type) {
      case 'rect': {
        const radii = c.radii;
        if (radii) {
          const animated = radii.some((r) => r.k && r.k.length > 1);
          const equal = radii.every((r) => Math.abs(r.v - radii[0]!.v) < 1e-4);
          const sized = c.size.mode === 'vec' ? !c.size.a.k : !c.size.x.k && !c.size.y.k;
          if (!animated && !equal && sized) {
            // Four different corners: After Effects' rectangle has one roundness, so it is drawn as a path.
            const size = evalAnimVec(c.size, 0);
            const path = cornersSubPath(0, 0, size.x, size.y, [radii[0]!.v, radii[1]!.v, radii[2]!.v, radii[3]!.v]);
            return [{ mn: 'ADBE Vector Shape - Group', name: 'Path', path: pathOf(path) }, ...this.paints(c.style)];
          }
          if (!equal || animated) this.warn(`"${name}": the corners have different radii; After Effects' rectangle gets the first one.`, 'info');
        }
        return [
          {
            mn: 'ADBE Vector Shape - Rect',
            name: 'Rectangle Path',
            set: [
              ['ADBE Vector Rect Size', vecProp(c.size, same, false, this.fps)],
              ['ADBE Vector Rect Roundness', scalarProp(radii ? radii[0]! : c.radius, (v) => Math.max(0, v), this.fps)],
            ],
          },
          ...this.paints(c.style),
        ];
      }
      case 'ellipse':
        return [
          { mn: 'ADBE Vector Shape - Ellipse', name: 'Ellipse Path', set: [['ADBE Vector Ellipse Size', vecProp(c.size, same, false, this.fps)]] },
          ...this.paints(c.style),
        ];
      case 'path':
        return [
          ...c.paths.filter((sp) => sp.v.length > 0).map((sp, i): PlanShape => ({ mn: 'ADBE Vector Shape - Group', name: c.paths.length > 1 ? `Path ${i + 1}` : 'Path', path: pathOf(sp) })),
          ...this.paints(c.style),
        ];
      case 'group':
        return c.children.map((child) => this.groupItem(child)).filter((g): g is PlanShape => !!g);
      case 'empty':
        return [];
      default:
        this.warn(`"${name}": only shapes can sit inside a shape layer; this ${c.type} is left out.`);
        return [];
    }
  }

  private groupItem(el: Element): PlanShape | null {
    const items = this.contentItems(el.name, el.content);
    if (!items.length) return null;
    const t = el.transform;
    const tr: PlanSetting[] = [
      ['ADBE Vector Anchor', vecProp(t.anchor, same, true, this.fps)],
      ['ADBE Vector Position', vecProp(t.position, same, true, this.fps)],
      ['ADBE Vector Scale', vecProp(t.scale, pct, false, this.fps)],
      ['ADBE Vector Rotation', scalarProp(t.rotation, same, this.fps)],
      ['ADBE Vector Group Opacity', scalarProp(t.opacity, (v) => pct(clamp01(v)), this.fps)],
    ];
    return { mn: 'ADBE Vector Group', name: el.name || 'Group', items, tr };
  }

  private text(c: TextContent): PlanText {
    return {
      text: c.text.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\n/g, '\r'),
      font: c.postScriptName ?? '',
      family: c.fontFamily,
      style: c.fontStyle,
      size: r5(Math.max(0.1, c.fontSize)),
      fill: c.fill ? [r5(c.fill.r), r5(c.fill.g), r5(c.fill.b)] : null,
      stroke: c.stroke ? [r5(c.stroke.color.r), r5(c.stroke.color.g), r5(c.stroke.color.b)] : null,
      strokeWidth: c.stroke ? r5(c.stroke.width) : 0,
      justify: c.align,
      tracking: r5(c.tracking),
      leading: r5(c.lineHeight),
      caps: c.caps ?? '',
      box: c.box ? [r5(c.box.x), r5(c.box.y), r5(c.box.w), r5(c.box.h)] : null,
      origin: [r5(c.firstBaseline.x), r5(c.firstBaseline.y)],
      ink: c.ink ? [r5(c.ink.x), r5(c.ink.y), r5(c.ink.w), r5(c.ink.h)] : null,
    };
  }

  /**
   * A layer's transform. `fit`: an image that has other pixel dimensions than
   * the rectangle it covers - its anchor is counted in its own pixels and its
   * scale makes up for the difference.
   */
  private transform(t: Transform, fit: Vec2 = { x: 1, y: 1 }): { tr: PlanSetting[]; sep: boolean } {
    const tr: PlanSetting[] = [];
    const anchor = vecProp(t.anchor, same, true, this.fps);
    stretch(anchor, 1 / fit.x, 1 / fit.y);
    tr.push(['ADBE Anchor Point', anchor]);
    const split = t.position.mode === 'split' && ((t.position.x.k?.length ?? 0) > 1 || (t.position.y.k?.length ?? 0) > 1);
    if (split && t.position.mode === 'split') {
      tr.push(['ADBE Position_0', scalarProp(t.position.x, same, this.fps)], ['ADBE Position_1', scalarProp(t.position.y, same, this.fps)]);
    } else {
      tr.push(['ADBE Position', vecProp(t.position, same, true, this.fps)]);
    }
    const scale = vecProp(t.scale, pct, false, this.fps);
    stretch(scale, fit.x, fit.y);
    tr.push(['ADBE Scale', scale], ['ADBE Rotate Z', scalarProp(t.rotation, same, this.fps)], ['ADBE Opacity', scalarProp(t.opacity, (v) => pct(clamp01(v)), this.fps)]);
    return { tr, sep: split };
  }

  private layer(l: Layer, comp: Comp, duration: number, footage: Map<string, PlanFootage>): PlanLayer | null {
    this.where = { comp: comp.name, layer: l.name };
    const c = l.content;
    let type: PlanLayerType;
    let fit: Vec2 = { x: 1, y: 1 };
    const out: Partial<PlanLayer> = {};

    switch (c.type) {
      case 'rect':
      case 'ellipse':
      case 'path': {
        type = 'shape';
        const items = this.contentItems(l.name, c);
        out.shape = [{ mn: 'ADBE Vector Group', name: c.type === 'rect' ? 'Rectangle' : c.type === 'ellipse' ? 'Ellipse' : 'Shape', items }];
        break;
      }
      case 'group':
        type = 'shape';
        out.shape = this.contentItems(l.name, c);
        break;
      case 'text':
        type = 'text';
        out.text = this.text(c);
        break;
      case 'solid':
        type = 'solid';
        out.solid = { w: Math.max(1, Math.round(c.width)), h: Math.max(1, Math.round(c.height)), color: [r5(c.color.r), r5(c.color.g), r5(c.color.b)] };
        break;
      case 'empty':
        type = 'null';
        out.size = [Math.max(1, Math.round(c.width)), Math.max(1, Math.round(c.height))];
        break;
      case 'image': {
        const asset = this.doc.assets[c.assetId];
        const file = this.opts.files[c.assetId];
        if (!asset || !file) {
          // The picture did not arrive: a grey box of the same size keeps its place.
          this.warn('The image could not be transferred; a grey solid stands in for it.');
          type = 'solid';
          out.solid = { w: Math.max(1, Math.round(c.width)), h: Math.max(1, Math.round(c.height)), color: [0.5, 0.5, 0.5] };
          break;
        }
        type = 'image';
        if (!footage.has(c.assetId)) footage.set(c.assetId, { id: c.assetId, name: asset.name, file, w: asset.width, h: asset.height });
        out.image = { footage: c.assetId };
        if (asset.width > 0 && asset.height > 0 && c.width > 0 && c.height > 0) fit = { x: c.width / asset.width, y: c.height / asset.height };
        break;
      }
      case 'comp': {
        if (!this.doc.comps[c.compId]) {
          this.warn('The nested composition is missing from the transfer; the layer is left out.');
          return null;
        }
        type = 'comp';
        out.comp = { id: c.compId, start: r5(c.startTime) };
        if (c.remap) out.comp.remap = scalarProp(c.remap, same, this.fps);
        break;
      }
    }

    const { tr, sep } = this.transform(l.transform, fit);
    const layer: PlanLayer = { id: l.id, name: l.name || 'Layer', type, tr, ...out };
    if (sep) layer.sep = 1;
    if (l.parentId !== undefined) layer.parent = l.parentId;
    if (l.hidden && type !== 'null') layer.off = 1;
    if (l.blendMode && l.blendMode !== 'normal') layer.blend = l.blendMode;
    if (l.matte) {
      layer.matte = { id: l.matte.layerId };
      if (l.matte.luma) layer.matte.luma = 1;
      if (l.matte.inverted) layer.matte.inverted = 1;
    }
    // A layer that is there from start to end needs nothing set; so does every layer of a frame without timing.
    const whole = duration <= 0 || (l.inPoint <= 1e-6 && l.outPoint >= duration - 1e-6);
    if (!whole && l.outPoint > l.inPoint) layer.span = [r5(l.inPoint), r5(l.outPoint)];
    if (l.shadow) {
      const s = l.shadow;
      layer.shadow = {
        color: [r5(s.color.r), r5(s.color.g), r5(s.color.b)],
        opacity: r5(clamp01(s.color.a)),
        // Direction 0 points up and turns clockwise.
        direction: r5((((Math.atan2(s.offset.x, -s.offset.y) * 180) / Math.PI) % 360 + 360) % 360),
        distance: r5(Math.hypot(s.offset.x, s.offset.y)),
        softness: r5(Math.max(0, s.blur) * 2),
      };
    }
    return layer;
  }

  build(): BuildPlan {
    const doc = this.doc;
    const root = doc.comps[doc.rootCompId]!;
    const rate = (c: Comp): number => Math.max(1, Math.min(99, c.frameRate > 0 ? c.frameRate : root.frameRate > 0 ? root.frameRate : this.opts.frameRate));
    const length = (c: Comp): number => (c.duration > 0 ? c.duration : root.duration > 0 ? root.duration : this.opts.duration);

    const comps: PlanComp[] = [];
    const footage = new Map<string, PlanFootage>();
    const done = new Set<string>();
    const visit = (comp: Comp, trail: string[]): void => {
      if (done.has(comp.id)) return;
      done.add(comp.id);
      for (const l of comp.layers) {
        if (l.content.type !== 'comp') continue;
        const nested = doc.comps[l.content.compId];
        // A composition cannot hold itself.
        if (nested && trail.indexOf(nested.id) === -1) visit(nested, [...trail, comp.id]);
      }
      this.fps = rate(comp);
      const duration = Math.max(1 / this.fps, length(comp));
      const layers: PlanLayer[] = [];
      for (const l of comp.layers) {
        const planned = this.layer(l, comp, comp.duration > 0 ? comp.duration : 0, footage);
        if (planned) layers.push(planned);
      }
      comps.push({
        id: comp.id,
        name: comp.name || 'Composition',
        w: Math.max(4, Math.min(30000, Math.round(comp.width))),
        h: Math.max(4, Math.min(30000, Math.round(comp.height))),
        duration: r5(duration),
        frameRate: r5(this.fps),
        bg: [r5(comp.background.r), r5(comp.background.g), r5(comp.background.b)],
        layers,
      });
    };
    visit(root, []);
    return { name: root.name || 'Composition', root: root.id, comps, footage: [...footage.values()], folder: `${root.name || 'Composition'} (Figma)` };
  }
}

/** Multiplies a two-axis value, keys and speeds included, by a factor per axis. */
function stretch(prop: PlanProp, fx: number, fy: number): void {
  if (Math.abs(fx - 1) < 1e-9 && Math.abs(fy - 1) < 1e-9) return;
  const f = [fx, fy];
  const scaleValue = (v: number | number[]): number | number[] => (Array.isArray(v) ? v.map((n, d) => r5(n * (f[d] ?? 1))) : v);
  prop.v = scaleValue(prop.v);
  for (const k of prop.k ?? []) {
    k.v = scaleValue(k.v);
    // One ease for the whole value means the speed is a length; an even factor scales it, an uneven one only roughly.
    const whole = k.ie.length === 1;
    k.ie = k.ie.map((e, d) => ({ s: r5(e.s * (whole ? (fx + fy) / 2 : (f[d] ?? 1))), i: e.i }));
    k.oe = k.oe.map((e, d) => ({ s: r5(e.s * (whole ? (fx + fy) / 2 : (f[d] ?? 1))), i: e.i }));
  }
}

/** The plan After Effects builds the document from, and what could not be planned. */
export function planBuild(doc: BridgeDoc, opts: BuildOptions): PlanResult {
  const planner = new Planner(doc, opts);
  const plan = planner.build();
  return { plan, warnings: planner.warnings };
}

/**
 * The plan as text for ExtendScript, which has no JSON parser and reads the
 * file with `eval`: plain ASCII, so neither the file's encoding nor a line
 * separator inside a layer name can break it.
 */
export function planText(plan: BuildPlan): string {
  return JSON.stringify(plan).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
