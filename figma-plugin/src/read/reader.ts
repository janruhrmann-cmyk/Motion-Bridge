/**
 * Figma -> After Effects: reads frames into bridge documents, one composition
 * per frame. This is builder.ts the other way round.
 *
 * How a Figma design is told as a composition:
 *
 *  - A top-level frame is a composition. What is inside becomes layers, the
 *    front-most first.
 *
 *  - Figma nests, After Effects parents. A frame or group inside the frame
 *    does not have to become a nested composition: where nesting changes
 *    nothing about the picture, its children are simply layers of the same
 *    composition. A frame with a fill becomes a shape layer that its children
 *    follow (parenting), so moving it moves all of it; a frame that only holds
 *    things disappears, unless it is animated itself - then a null object
 *    carries its motion.
 *
 *  - A frame becomes a nested composition only where After Effects needs one:
 *    it clips what is inside (and something does poke out, or moves), it fades
 *    or blends several things as one, or it has a picture as its fill.
 *    Rounded corners that clip become a track matte on that layer.
 *
 *  - A Figma mask is a track matte: the mask is a layer that is not drawn, and
 *    every layer above it in its frame uses it.
 *
 *  - Figma rotates and scales a node around its centre, and its keyframes add
 *    to the node at rest (translation, rotation) or multiply it (scale). A
 *    layer therefore gets its anchor point on the node's centre, and the keys
 *    are the resting value plus the track.
 *
 *  - What After Effects has no shape for - gradients, picture fills on a
 *    shape, blurs - arrives as a picture of the node (exported by Figma at
 *    twice its size), so it looks right even though it is no longer editable.
 *    Text always stays text.
 *
 * Nothing in the Figma file is changed by reading it.
 */
import type {
  Anim,
  AnimVec2,
  BlendMode as BridgeBlendMode,
  BridgeDoc,
  Comp,
  Content,
  DropShadow,
  Ease,
  Element,
  Key,
  Layer,
  Paint as BridgePaint,
  RGBA,
  ShapeStyle,
  SubPath,
  TextContent,
  Transform,
  Vec2,
  Warning,
} from '../../../shared/format.ts';
import { FORMAT_NAME, FORMAT_VERSION } from '../../../shared/format.ts';
import type { Ops } from '../../../shared/anim.ts';
import { evalKeys, fitSamples, numOps, vecOps } from '../../../shared/anim.ts';
import { insideRounded, svgToSubPaths } from '../../../shared/geometry.ts';
import { BRIDGE_VERSION } from '../../../shared/protocol.ts';

export interface ReadOutput {
  docs: BridgeDoc[];
  /** The pictures the documents use, by asset id. */
  images: Record<string, Uint8Array>;
}

// ------------------------------------------------------------------ matrices

/** x' = a x + c y + e,  y' = b x + d y + f */
type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const shift = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
/** m1 applied after m2. */
const mul = (m1: Mat, m2: Mat): Mat => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
const at = (m: Mat, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
/** Only the turning and scaling part: for directions and offsets. */
const turn = (m: Mat, v: Vec2): Vec2 => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });
function inverse(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
const fromFigma = (t: readonly (readonly number[])[]): Mat => [t[0]![0]!, t[1]![0]!, t[0]![1]!, t[1]![1]!, t[0]![2]!, t[1]![2]!];

/** A matrix as After Effects describes one: turned clockwise by `rotation` degrees, then scaled. */
function decompose(m: Mat): { rotation: number; sx: number; sy: number; flipped: boolean } {
  const sx = Math.hypot(m[0], m[1]) || 1;
  const det = m[0] * m[3] - m[1] * m[2];
  return { rotation: (Math.atan2(m[1], m[0]) * 180) / Math.PI, sx, sy: det / sx, flipped: det < 0 };
}

// --------------------------------------------------------------- loose nodes

/** Figma's node types share most properties but not all; this reads one without caring which node it is. */
function get<T>(node: BaseNode | object, name: string): T | undefined {
  try {
    return (node as unknown as Record<string, T | undefined>)[name];
  } catch {
    return undefined;
  }
}

const isMixed = (v: unknown): boolean => typeof v === 'symbol';
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION']);
/** Nodes that hold others without a coordinate space of their own: what is inside is placed in the space around them. */
const SPACELESS = new Set(['GROUP', 'BOOLEAN_OPERATION']);
const SHAPES = new Set(['RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);

const BLEND: Record<string, BridgeBlendMode> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LINEAR_BURN: 'linear-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  LINEAR_DODGE: 'linear-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const visible = (node: SceneNode): boolean => get<boolean>(node, 'visible') !== false;
const kidsOf = (node: SceneNode): SceneNode[] => (get<readonly SceneNode[]>(node, 'children') ?? []).filter(visible);
const sizeOf = (node: SceneNode): Vec2 => ({ x: num(get(node, 'width'), 0), y: num(get(node, 'height'), 0) });
const absOf = (node: SceneNode): Mat => {
  const t = get<readonly (readonly number[])[]>(node, 'absoluteTransform');
  return t ? fromFigma(t) : IDENTITY;
};

// ------------------------------------------------------------------- tracks

interface TrackIn {
  keyframeOperation?: 'SET' | 'OFFSET' | 'SCALE';
  keyframes: ReadonlyArray<{ timelinePosition: number; value: { type: string; value: unknown }; easing?: unknown }>;
}
interface BindingIn {
  tracks?: ReadonlyArray<TrackIn>;
  timelineDuration?: number;
}

/** Figma's named eases as the curves they are. */
const NAMED: Record<string, [number, number, number, number]> = {
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};
/** Figma's named springs, as the bounce of its normalised spring. */
const SPRINGS: Record<string, number> = { GENTLE: 0.2, QUICK: 0.1, BOUNCY: 0.6, SLOW: 0 };

function easeOf(e: unknown): Ease | undefined {
  const type = e && typeof e === 'object' ? get<string>(e, 'type') : undefined;
  if (!type || type === 'LINEAR') return undefined;
  if (type === 'HOLD') return { type: 'hold' };
  if (type === 'CUSTOM_CUBIC_BEZIER') {
    const b = get<{ x1: number; y1: number; x2: number; y2: number }>(e as object, 'easingFunctionCubicBezier');
    return b ? { type: 'bezier', x1: clamp01(b.x1), y1: b.y1, x2: clamp01(b.x2), y2: b.y2 } : undefined;
  }
  if (type === 'CUSTOM_SPRING') {
    const s = get<{ bounce: number }>(e as object, 'easingFunctionSpring');
    return { type: 'spring', bounce: clamp01(num(s?.bounce, 0)) };
  }
  const named = NAMED[type];
  if (named) return { type: 'bezier', x1: named[0], y1: named[1], x2: named[2], y2: named[3] };
  const spring = SPRINGS[type];
  if (spring !== undefined) return { type: 'spring', bounce: spring };
  // An ease bound to a variable, or one this version does not know: a straight line is the honest guess.
  return undefined;
}

interface Kind<T> {
  type: string;
  ops: Ops<T> | null;
  read(v: unknown): T | null;
  add(a: T, b: T): T;
  times(a: T, b: T): T;
}

const FLOAT: Kind<number> = {
  type: 'FLOAT',
  ops: numOps,
  read: (v) => (typeof v === 'number' && isFinite(v) ? v : null),
  add: (a, b) => a + b,
  times: (a, b) => a * b,
};
const VECTOR: Kind<Vec2> = {
  type: 'VECTOR',
  ops: vecOps,
  read: (v) => {
    const x = get<number>(v as object, 'x');
    const y = get<number>(v as object, 'y');
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
  },
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  times: (a, b) => ({ x: a.x * b.x, y: a.y * b.y }),
};
const COLOR: Kind<RGBA> = {
  type: 'COLOR',
  ops: null,
  read: (v) => {
    const c = v as Partial<RGBA> | null;
    return c && typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number' ? { r: c.r, g: c.g, b: c.b, a: typeof c.a === 'number' ? c.a : 1 } : null;
  },
  add: (_a, b) => b,
  times: (_a, b) => b,
};

/**
 * The keys of one animated property. A node can carry several tracks for the
 * same property (its own keyframes and an animation style); each says whether
 * it sets the value, adds to it or multiplies it. `start` is what they act on.
 * A single returned key means: this value, all the time.
 */
function keysOf<T>(binding: unknown, kind: Kind<T>, start: T, fps: number): Key<T>[] | null {
  const tracks = (get<ReadonlyArray<TrackIn>>(binding as object, 'tracks') ?? []).filter((t) => t && t.keyframes && t.keyframes.length);
  const lists: Array<{ op: string; keys: Key<T>[] }> = [];
  for (const track of tracks) {
    const keys: Key<T>[] = [];
    for (const f of [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition)) {
      if (!f.value || f.value.type !== kind.type) continue;
      const v = kind.read(f.value.value);
      if (v === null) continue;
      const key: Key<T> = { t: r4(Math.max(0, f.timelinePosition)), v };
      const e = keys.length ? easeOf(f.easing) : undefined;
      if (e) key.e = e;
      // Two keys on one moment: the later one counts.
      if (keys.length && Math.abs(keys[keys.length - 1]!.t - key.t) < 1e-6) keys[keys.length - 1] = { ...key, e: keys[keys.length - 1]!.e } as Key<T>;
      else keys.push(key);
    }
    if (keys.length) lists.push({ op: track.keyframeOperation ?? 'SET', keys });
  }
  if (!lists.length) return null;
  const act = (op: string, acc: T, v: T): T => (op === 'OFFSET' ? kind.add(acc, v) : op === 'SCALE' ? kind.times(acc, v) : v);
  if (lists.length === 1) return lists[0]!.keys.map((k) => ({ ...k, v: act(lists[0]!.op, start, k.v) }));
  // Several tracks: what they add up to, sampled and fitted with eases again.
  if (!kind.ops) return lists[lists.length - 1]!.keys;
  const ops = kind.ops;
  const all = lists.flatMap((l) => l.keys.map((k) => k.t));
  const t0 = Math.min(...all);
  const t1 = Math.max(...all);
  const value = (t: number): T => lists.reduce((acc, l) => act(l.op, acc, evalKeys(l.keys, t, ops)), start);
  if (t1 - t0 < 1e-6) return [{ t: t0, v: value(t0) }];
  const fitted = sampled(t0, t1, fps, value, ops, 1e-3);
  return fitted.length ? fitted : [{ t: t0, v: value(t0) }];
}

function sampled<T>(t0: number, t1: number, fps: number, value: (t: number) => T, ops: Ops<T>, tol: number): Key<T>[] {
  const steps = Math.max(2, Math.round((t1 - t0) * fps));
  const times: number[] = [];
  const values: T[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    times.push(r4(t));
    values.push(value(t));
  }
  return fitSamples(times, values, ops, tol);
}

/** A value with its keys, if it has any that change it. */
function anim<T>(rest: T, keys: Key<T>[] | null | undefined): Anim<T> {
  if (!keys || !keys.length) return { v: rest };
  if (keys.length === 1) return { v: keys[0]!.v };
  return { v: rest, k: keys };
}
const mapKeys = <T, U>(keys: Key<T>[], f: (v: T) => U): Key<U>[] => keys.map((k) => (k.e ? { t: k.t, v: f(k.v), e: k.e } : { t: k.t, v: f(k.v) }));
const moves = <T>(keys: Key<T>[] | null | undefined): keys is Key<T>[] => !!keys && keys.length > 1;
const evalAt = <T>(a: Anim<T>, t: number, ops: Ops<T>): T => (a.k && a.k.length ? evalKeys(a.k, t, ops) : a.v);
/** The first and last key time of every list that has more than one key. */
function spanOf(...lists: Array<ReadonlyArray<{ t: number }> | null | undefined>): number[] {
  const out: number[] = [];
  for (const keys of lists) if (keys && keys.length > 1) out.push(keys[0]!.t, keys[keys.length - 1]!.t);
  return out;
}

/** Everything a node's timeline says about it. */
class Tracks {
  private readonly all: Record<string, unknown>;
  readonly fps = 60;

  constructor(node: SceneNode) {
    this.all = get<Record<string, unknown>>(node, 'animations') ?? {};
  }
  float(name: string, start: number): Key<number>[] | null {
    return keysOf(this.all[name], FLOAT, start, this.fps);
  }
  vector(name: string, start: Vec2): Key<Vec2>[] | null {
    return keysOf(this.all[name], VECTOR, start, this.fps);
  }
  color(collection: 'fills' | 'strokes', index: number, start: RGBA): Key<RGBA>[] | null {
    const list = this.all[collection] as Record<number, unknown> | undefined;
    return list ? keysOf(list[index], COLOR, start, this.fps) : null;
  }
  has(...names: string[]): boolean {
    return names.some((n) => {
      const tracks = get<ReadonlyArray<TrackIn>>(this.all[n] as object, 'tracks');
      return !!tracks && tracks.some((t) => t.keyframes && t.keyframes.length > 0);
    });
  }
  /** The node is moved, turned or scaled over time. */
  get transforms(): boolean {
    return this.has('TRANSLATION_X', 'TRANSLATION_Y', 'TRANSLATION_XY', 'ROTATION', 'SCALE_X', 'SCALE_Y', 'SCALE_XY');
  }
  get any(): boolean {
    for (const name of Object.keys(this.all)) {
      if (name === 'fills' || name === 'strokes' || name === 'effects') {
        if (Object.keys((this.all[name] as object) ?? {}).length) return true;
      } else if (this.has(name)) return true;
    }
    return false;
  }
  /** How long the timeline the node is on runs, as far as its own tracks say. */
  get reach(): number {
    let end = 0;
    for (const name of Object.keys(this.all)) {
      const b = this.all[name] as BindingIn | undefined;
      for (const t of b?.tracks ?? []) for (const f of t.keyframes ?? []) end = Math.max(end, f.timelinePosition);
    }
    return end;
  }
}

// ------------------------------------------------------------------ reading

interface Info {
  tracks: Tracks;
  /** Something below this node has keyframes. */
  movesInside: boolean;
}

interface Ctx {
  comp: Comp;
  /** Page space -> the space new layers are placed in: the composition, or the layer they follow. */
  toSpace: Mat;
  parentId?: string;
  matte?: { layerId: string; luma?: boolean };
  /** The opacity and blend mode of frames above that were dissolved into their only child. */
  opacity: Anim<number>;
  blend?: BridgeBlendMode;
  /** The node is a mask: it has to arrive as one layer. */
  asMask?: boolean;
}

class Reader {
  readonly comps: Record<string, Comp> = {};
  readonly assets: BridgeDoc['assets'] = {};
  readonly warnings: Warning[] = [];
  readonly images: Record<string, Uint8Array>;
  private readonly info = new Map<string, Info>();
  private readonly seen = new Set<string>();
  private readonly counters = new Map<Comp, number>();
  private comps_ = 0;
  private rootName = '';

  constructor(images: Record<string, Uint8Array>) {
    this.images = images;
  }

  private warn(node: { name: string } | null, message: string, level: 'info' | 'warn' = 'warn'): void {
    const key = `${node?.name ?? ''}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const w: Warning = { level, message, comp: this.rootName };
    if (node) w.layer = node.name;
    this.warnings.push(w);
  }

  private scan(node: SceneNode): Info {
    const tracks = new Tracks(node);
    let movesInside = false;
    for (const child of kidsOf(node)) {
      const below = this.scan(child);
      if (below.movesInside || below.tracks.any) movesInside = true;
    }
    const info = { tracks, movesInside };
    this.info.set(node.id, info);
    return info;
  }

  private of(node: SceneNode): Info {
    return this.info.get(node.id) ?? this.scan(node);
  }

  private newId(comp: Comp): string {
    const n = (this.counters.get(comp) ?? 0) + 1;
    this.counters.set(comp, n);
    return `L${n}`;
  }

  private newComp(name: string, w: number, h: number, duration: number): Comp {
    const id = this.comps_ === 0 ? 'root' : `c${this.comps_}`;
    this.comps_++;
    const comp: Comp = { id, name, width: Math.max(4, Math.round(w)), height: Math.max(4, Math.round(h)), duration, frameRate: 0, background: { r: 0, g: 0, b: 0, a: 1 }, layers: [] };
    this.comps[id] = comp;
    return comp;
  }

  /** A layer of the composition being filled, with what every layer has. */
  private layer(ctx: Ctx, name: string, content: Content, transform: Transform, extra: Partial<Layer> = {}): Layer {
    const layer: Layer = { id: this.newId(ctx.comp), name, transform, content, inPoint: 0, outPoint: ctx.comp.duration, ...extra };
    if (ctx.parentId !== undefined && layer.parentId === undefined) layer.parentId = ctx.parentId;
    if (ctx.matte && !layer.matte && !layer.hidden) layer.matte = { ...ctx.matte };
    if (ctx.blend && !layer.blendMode) layer.blendMode = ctx.blend;
    return layer;
  }

  // ------------------------------------------------------------ transforms

  /**
   * A node's place over time, as a layer transform. `anchor` is where the
   * node's centre lies in the space of what the layer draws (the middle of a
   * rectangle centred on its origin is 0,0; of a path drawn in node space,
   * half its size). `sizes`: the node's size is keyframed, so its centre
   * moves - Figma grows a node from its top-left corner.
   */
  private place(
    node: SceneNode,
    ctx: Ctx,
    anchor: (size: Vec2) => Vec2,
    o: {
      sizes?: { w: Anim<number>; h: Anim<number> };
      opacity?: Anim<number>;
      /** Node space -> page space, when that is not the node's own matrix (a picture of the node is upright on the page). */
      rest?: Mat;
      /** The node's own motion is carried by another layer (its composition's): this one only follows its size. */
      still?: boolean;
    } = {},
  ): Transform {
    const tracks = this.of(node).tracks;
    const fps = tracks.fps;
    const size = sizeOf(node);
    // Node space -> the space the layer is placed in.
    const m = mul(ctx.toSpace, o.rest ?? absOf(node));
    const rest = decompose(m);
    // Keyframed offsets are counted in the space around the node, which may itself be turned in ours.
    const around = mul(ctx.toSpace, this.spaceAround(node));

    const xy = o.still ? null : tracks.vector('TRANSLATION_XY', { x: 0, y: 0 });
    const tx = o.still ? null : tracks.float('TRANSLATION_X', 0);
    const ty = o.still ? null : tracks.float('TRANSLATION_Y', 0);
    const w = o.sizes?.w ?? { v: size.x };
    const h = o.sizes?.h ?? { v: size.y };
    const sized = !!(w.k || h.k);
    const centre = (t: number): Vec2 => ({ x: evalAt(w, t, numOps) / 2, y: evalAt(h, t, numOps) / 2 });
    const offset = (t: number): Vec2 => {
      const a = xy && xy.length ? evalKeys(xy, t, vecOps) : { x: 0, y: 0 };
      return { x: a.x + (tx && tx.length ? evalKeys(tx, t, numOps) : 0), y: a.y + (ty && ty.length ? evalKeys(ty, t, numOps) : 0) };
    };
    const whereAt = (t: number): Vec2 => {
      const p = at(m, centre(t));
      const d = turn(around, offset(t));
      return { x: p.x + d.x, y: p.y + d.y };
    };
    const p0 = at(m, { x: size.x / 2, y: size.y / 2 });

    let position: AnimVec2;
    const straight = Math.abs(around[1]) < 1e-6 && Math.abs(around[2]) < 1e-6;
    if (!xy && !tx && !ty && !sized) {
      position = { mode: 'vec', a: { v: p0 } };
    } else if (xy && !tx && !ty && !sized) {
      position = { mode: 'vec', a: anim(p0, mapKeys(xy, (v) => ({ x: p0.x + turn(around, v).x, y: p0.y + turn(around, v).y }))) };
    } else if (!xy && !sized && straight) {
      position = {
        mode: 'split',
        x: anim(p0.x, tx ? mapKeys(tx, (v) => p0.x + around[0] * v) : null),
        y: anim(p0.y, ty ? mapKeys(ty, (v) => p0.y + around[3] * v) : null),
      };
    } else {
      // Several things move the centre at once: follow it frame by frame and fit eases to that.
      const ends = spanOf(xy, tx, ty, w.k, h.k);
      const single = whereAt(ends.length ? Math.min(...ends) : 0);
      const fitted = ends.length ? sampled(Math.min(...ends), Math.max(...ends), fps, whereAt, vecOps, 0.02) : [];
      position = { mode: 'vec', a: fitted.length ? { v: whereAt(0), k: fitted } : { v: single } };
    }

    // Figma turns counter-clockwise, After Effects clockwise; a mirrored node turns the other way round.
    const spin = o.still ? null : tracks.float('ROTATION', 0);
    const sign = rest.flipped ? 1 : -1;
    const rotation = anim(rest.rotation, spin ? mapKeys(spin, (v) => rest.rotation + sign * v) : null);

    const sxy = o.still ? null : tracks.vector('SCALE_XY', { x: 1, y: 1 });
    const sx = o.still ? null : tracks.float('SCALE_X', 1);
    const sy = o.still ? null : tracks.float('SCALE_Y', 1);
    let scale: AnimVec2;
    if (sxy && !sx && !sy) {
      scale = { mode: 'vec', a: anim({ x: rest.sx, y: rest.sy }, mapKeys(sxy, (v) => ({ x: rest.sx * v.x, y: rest.sy * v.y }))) };
    } else if (sxy) {
      const times = spanOf(sxy, sx, sy);
      const value = (t: number): Vec2 => {
        const both = evalKeys(sxy, t, vecOps);
        return { x: rest.sx * both.x * (sx ? evalKeys(sx, t, numOps) : 1), y: rest.sy * both.y * (sy ? evalKeys(sy, t, numOps) : 1) };
      };
      const fitted = times.length ? sampled(Math.min(...times), Math.max(...times), fps, value, vecOps, 0.0005) : [];
      scale = { mode: 'vec', a: fitted.length ? { v: value(0), k: fitted } : { v: value(0) } };
    } else if (sx || sy) {
      scale = { mode: 'split', x: anim(rest.sx, sx ? mapKeys(sx, (v) => rest.sx * v) : null), y: anim(rest.sy, sy ? mapKeys(sy, (v) => rest.sy * v) : null) };
    } else {
      scale = { mode: 'vec', a: { v: { x: rest.sx, y: rest.sy } } };
    }

    const own = o.opacity ?? anim(clamp01(num(get(node, 'opacity'), 1)), tracks.float('OPACITY', num(get(node, 'opacity'), 1)));
    const a0 = anchor(size);
    let anchorAnim: AnimVec2 = { mode: 'vec', a: { v: a0 } };
    if (sized && (Math.abs(a0.x) > 1e-9 || Math.abs(a0.y) > 1e-9)) {
      // Content that is drawn from the node's corner: its middle moves as the node grows.
      anchorAnim = { mode: 'split', x: w.k ? { v: a0.x, k: mapKeys(w.k, (v) => anchor({ x: v, y: size.y }).x) } : { v: a0.x }, y: h.k ? { v: a0.y, k: mapKeys(h.k, (v) => anchor({ x: size.x, y: v }).y) } : { v: a0.y } };
    }
    return { anchor: anchorAnim, position, scale, rotation, opacity: this.fade(own, ctx.opacity, fps) };
  }

  /** The space a node's keyframed offsets are counted in, as a matrix into page space. */
  private spaceAround(node: SceneNode): Mat {
    let parent = node.parent;
    while (parent && SPACELESS.has(parent.type)) parent = parent.parent;
    if (!parent || parent.type === 'PAGE' || parent.type === 'DOCUMENT') return IDENTITY;
    return absOf(parent as SceneNode);
  }

  /** Two opacities that apply to the same thing. */
  private fade(a: Anim<number>, b: Anim<number>, fps: number): Anim<number> {
    const c = (n: number): number => r4(clamp01(n));
    if (!b.k) return a.k ? { v: c(a.v * b.v), k: mapKeys(a.k, (v) => c(v * b.v)) } : { v: c(a.v * b.v) };
    if (!a.k) return { v: c(a.v * b.v), k: mapKeys(b.k, (v) => c(v * a.v)) };
    const ends = [a.k, b.k].flatMap((k) => [k[0]!.t, k[k.length - 1]!.t]);
    const value = (t: number): number => c(evalKeys(a.k!, t, numOps) * evalKeys(b.k!, t, numOps));
    const fitted = sampled(Math.min(...ends), Math.max(...ends), fps, value, numOps, 0.002);
    return fitted.length ? { v: value(0), k: fitted } : { v: value(0) };
  }

  // ------------------------------------------------------- paints and styles

  /** The solid paints of a node, front-most first, each with its colour keys. */
  private solids(node: SceneNode, collection: 'fills' | 'strokes'): { paints: BridgePaint[]; image: ImagePaint | null; other: string[]; mixed: boolean } {
    const raw = get<unknown>(node, collection);
    const out = { paints: [] as BridgePaint[], image: null as ImagePaint | null, other: [] as string[], mixed: isMixed(raw) };
    if (!Array.isArray(raw)) return out;
    const tracks = this.of(node).tracks;
    (raw as Paint[]).forEach((p, index) => {
      if (!p || p.visible === false || (p.opacity ?? 1) <= 0) return;
      if (p.type === 'SOLID') {
        const rest: RGBA = { r: p.color.r, g: p.color.g, b: p.color.b, a: clamp01(p.opacity ?? 1) };
        out.paints.unshift({ color: anim(rest, tracks.color(collection, index, rest)) });
      } else if (p.type === 'IMAGE' && !out.image) out.image = p;
      else out.other.push(p.type === 'IMAGE' ? 'a second picture' : p.type.indexOf('GRADIENT') !== -1 ? 'a gradient' : 'a pattern or video');
    });
    return out;
  }

  private shadowOf(node: SceneNode): { shadow: DropShadow | null; other: string[] } {
    const effects = get<readonly Effect[]>(node, 'effects') ?? [];
    let shadow: DropShadow | null = null;
    const other: string[] = [];
    for (const fx of effects) {
      if (!fx || fx.visible === false) continue;
      if (fx.type === 'DROP_SHADOW' && !shadow) {
        shadow = { color: { r: fx.color.r, g: fx.color.g, b: fx.color.b, a: fx.color.a }, offset: { x: fx.offset.x, y: fx.offset.y }, blur: fx.radius };
      } else other.push(fx.type === 'DROP_SHADOW' ? 'a second shadow' : fx.type.toLowerCase().replace(/_/g, ' '));
    }
    return { shadow, other };
  }

  private blendOf(node: SceneNode): BridgeBlendMode | undefined {
    return BLEND[get<string>(node, 'blendMode') ?? ''];
  }

  private strokeStyle(node: SceneNode, strokes: BridgePaint[]): Partial<ShapeStyle> {
    if (!strokes.length) return {};
    const tracks = this.of(node).tracks;
    const weight = num(get(node, 'strokeWeight'), 1);
    const style: Partial<ShapeStyle> = { strokeWidth: anim(weight, tracks.float('STROKE_WEIGHT', weight)) };
    const cap = get<string>(node, 'strokeCap');
    if (cap === 'ROUND') style.cap = 'round';
    else if (cap === 'SQUARE') style.cap = 'square';
    else if (typeof cap === 'string' && cap !== 'NONE') this.warn(node, 'Arrow heads and other line endings are not transferred; the line ends plainly.', 'info');
    const join = get<string>(node, 'strokeJoin');
    if (join === 'ROUND') style.join = 'round';
    else if (join === 'BEVEL') style.join = 'bevel';
    const miter = get<number>(node, 'strokeMiterLimit');
    if (typeof miter === 'number') style.miterLimit = miter;
    const dashes = get<readonly number[]>(node, 'dashPattern');
    if (dashes && dashes.length) style.dashes = [...dashes];
    return style;
  }

  private trimOf(node: SceneNode): ShapeStyle['trim'] | undefined {
    const tracks = this.of(node).tracks;
    const start = tracks.float('PATH_TRIM_START', 0);
    const end = tracks.float('PATH_TRIM_END', 1);
    if (!start && !end) return undefined;
    return { start: anim(0, start), end: anim(1, end), offset: { v: 0 } };
  }

  /**
   * A rectangle (or a frame's own box) with its fills and strokes. Figma draws
   * a stroke inside, outside or on the outline; After Effects only on it - so
   * a stroke that is not centred gets an outline of its own, moved by half its
   * width.
   */
  private box(node: SceneNode, fills: BridgePaint[], strokes: BridgePaint[], kind: 'rect' | 'ellipse'): { content: Content; sizes: { w: Anim<number>; h: Anim<number> } } {
    const tracks = this.of(node).tracks;
    const size = sizeOf(node);
    const sizes = { w: anim(size.x, tracks.float('WIDTH', size.x)), h: anim(size.y, tracks.float('HEIGHT', size.y)) };
    const grown = (by: number): AnimVec2 =>
      sizes.w.k || sizes.h.k
        ? { mode: 'split', x: sizes.w.k ? { v: sizes.w.v + by, k: mapKeys(sizes.w.k, (v) => Math.max(0, v + by)) } : { v: sizes.w.v + by }, y: sizes.h.k ? { v: sizes.h.v + by, k: mapKeys(sizes.h.k, (v) => Math.max(0, v + by)) } : { v: sizes.h.v + by } }
        : { mode: 'vec', a: { v: { x: Math.max(0, size.x + by), y: Math.max(0, size.y + by) } } };

    const corner = get<unknown>(node, 'cornerRadius');
    const each = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'].map((f) => num(get(node, f), 0));
    const fields = ['RECTANGLE_TOP_LEFT_CORNER_RADIUS', 'RECTANGLE_TOP_RIGHT_CORNER_RADIUS', 'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS', 'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS'];
    const uneven = typeof corner !== 'number' || tracks.has(...fields);
    const rounded = (by: number): { radius: Anim<number>; radii?: [Anim<number>, Anim<number>, Anim<number>, Anim<number>] } => {
      const fit = (v: number): number => (v > 0 ? Math.max(0, v + by) : 0);
      if (!uneven) {
        const keys = tracks.float('CORNER_RADIUS', corner as number);
        return { radius: anim(fit(corner as number), keys ? mapKeys(keys, fit) : null) };
      }
      const radii = each.map((r, i) => {
        const keys = tracks.float(fields[i]!, r);
        return anim(fit(r), keys ? mapKeys(keys, fit) : null);
      }) as [Anim<number>, Anim<number>, Anim<number>, Anim<number>];
      return { radius: radii[0], radii };
    };

    const weight = num(get(node, 'strokeWeight'), 1);
    const align = get<string>(node, 'strokeAlign') ?? 'CENTER';
    const by = !strokes.length || align === 'CENTER' ? 0 : align === 'INSIDE' ? -weight : weight;
    const strokeStyle = this.strokeStyle(node, strokes);
    const trim = this.trimOf(node);
    const shape = (grow: number, style: ShapeStyle): Content => (kind === 'ellipse' ? { type: 'ellipse', size: grown(grow), style } : { type: 'rect', size: grown(grow), ...rounded(grow / 2), style });

    let content: Content;
    if (!by || !fills.length) {
      const style: ShapeStyle = { fills, strokes, ...strokeStyle };
      if (trim) style.trim = trim;
      content = shape(by, style);
    } else {
      const outline: ShapeStyle = { fills: [], strokes, ...strokeStyle };
      if (trim) outline.trim = trim;
      const still = (name: string, c: Content): Element => ({ name, transform: identity(), content: c });
      content = { type: 'group', children: [still('Stroke', shape(by, outline)), still('Fill', shape(0, { fills, strokes: [] }))] };
    }
    return { content, sizes };
  }

  // ------------------------------------------------------------------ leaves

  private paths(list: readonly { windingRule: string; data: string }[] | undefined): { paths: SubPath[]; evenodd: boolean } {
    const paths: SubPath[] = [];
    let evenodd = false;
    for (const p of list ?? []) {
      if (p.windingRule === 'EVENODD') evenodd = true;
      paths.push(...svgToSubPaths(p.data));
    }
    return { paths, evenodd };
  }

  /** Whether a shape can arrive as a shape layer. If not, why. */
  private drawable(node: SceneNode): string | null {
    const fills = this.solids(node, 'fills');
    const strokes = this.solids(node, 'strokes');
    if (fills.mixed) return 'different fills on its parts';
    if (fills.image) return 'a picture as its fill';
    if (fills.other.length) return `${fills.other[0]} as its fill`;
    if (strokes.image || strokes.other.length) return 'a stroke that is not a plain colour';
    if (strokes.paints.length && isMixed(get(node, 'strokeWeight'))) return 'strokes of different widths on its sides';
    const fx = this.shadowOf(node);
    if (fx.other.length) return `an effect (${fx.other[0]})`;
    return null;
  }

  private shape(node: SceneNode, ctx: Ctx): Layer[] {
    const fills = this.solids(node, 'fills').paints;
    const strokes = this.solids(node, 'strokes').paints;
    const fx = this.shadowOf(node);
    const extra: Partial<Layer> = {};
    const blend = this.blendOf(node);
    if (blend) extra.blendMode = blend;
    if (fx.shadow) extra.shadow = fx.shadow;
    const size = sizeOf(node);

    const arc = get<{ startingAngle: number; endingAngle: number; innerRadius: number }>(node, 'arcData');
    const fullCircle = !arc || (Math.abs(Math.abs(arc.endingAngle - arc.startingAngle) - Math.PI * 2) < 1e-4 && Math.abs(arc.innerRadius) < 1e-6);
    if (node.type === 'RECTANGLE' || (node.type === 'ELLIPSE' && fullCircle)) {
      const { content, sizes } = this.box(node, fills, strokes, node.type === 'RECTANGLE' ? 'rect' : 'ellipse');
      // A rectangle is drawn around its own middle, which is where the layer's anchor then is.
      return [this.layer(ctx, node.name, content, this.place(node, ctx, () => ({ x: 0, y: 0 }), { sizes }), extra)];
    }

    // Everything else is an outline. A centred stroke stays a stroke (and can be trimmed); a stroke drawn
    // inside or outside the outline arrives as the shape it covers, which is exact.
    const align = get<string>(node, 'strokeAlign') ?? 'CENTER';
    const own = node.type === 'VECTOR' ? this.paths(get(node, 'vectorPaths')) : this.paths(get(node, 'fillGeometry'));
    if (node.type === 'LINE') own.paths = [{ closed: false, v: [{ x: 0, y: 0 }, { x: size.x, y: 0 }], i: [{ x: 0, y: 0 }, { x: 0, y: 0 }], o: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }];
    const outlined = strokes.length > 0 && (align !== 'CENTER' || !own.paths.length) && node.type !== 'LINE';
    const style: ShapeStyle = { fills, strokes: outlined ? [] : strokes, ...(outlined ? {} : this.strokeStyle(node, strokes)) };
    if (own.evenodd) style.fillRule = 'evenodd';
    const trim = this.trimOf(node);
    if (trim && !outlined) style.trim = trim;
    const radius = get<unknown>(node, 'cornerRadius');
    if (node.type === 'VECTOR' && typeof radius === 'number' && radius > 0) style.cornerRadius = { v: radius };

    let content: Content = { type: 'path', paths: own.paths, style };
    if (outlined) {
      const edge = this.paths(get(node, 'strokeGeometry'));
      const edgeStyle: ShapeStyle = { fills: strokes, strokes: [] };
      const stroke: Content = { type: 'path', paths: edge.paths, style: edgeStyle };
      const still = (name: string, c: Content): Element => ({ name, transform: identity(), content: c });
      content = fills.length && own.paths.length ? { type: 'group', children: [still('Stroke', stroke), still('Fill', content)] } : stroke;
      if (trim) this.warn(node, 'Its stroke is drawn inside or outside the outline, so it arrives as a filled shape and its trim animation is left out.');
    }
    if (content.type === 'path' && !content.paths.length) return [];
    return [this.layer(ctx, node.name, content, this.place(node, ctx, (s) => ({ x: s.x / 2, y: s.y / 2 })), extra)];
  }

  private text(node: TextNode, ctx: Ctx): Layer[] {
    const first = <T>(value: T | symbol, range: (start: number, end: number) => T | symbol, fallback: T): T => {
      if (!isMixed(value)) return value as T;
      try {
        const v = range.call(node, 0, 1);
        return isMixed(v) ? fallback : (v as T);
      } catch {
        return fallback;
      }
    };
    const mixed = [node.fontName, node.fontSize, node.fills, node.letterSpacing, node.lineHeight].some(isMixed);
    if (mixed) this.warn(node, 'The text mixes several styles; After Effects gets the style of its first character.');
    const font = first<FontName>(node.fontName, node.getRangeFontName, { family: 'Inter', style: 'Regular' });
    const fontSize = first<number>(node.fontSize, node.getRangeFontSize, 12);
    const spacing = first<LetterSpacing>(node.letterSpacing, node.getRangeLetterSpacing, { value: 0, unit: 'PERCENT' }) ?? { value: 0, unit: 'PERCENT' };
    const leading = first<LineHeight>(node.lineHeight, node.getRangeLineHeight, { unit: 'AUTO' }) ?? { unit: 'AUTO' };
    const fills = first<readonly Paint[]>(node.fills as readonly Paint[] | symbol, node.getRangeFills as (s: number, e: number) => readonly Paint[] | symbol, []);

    let text = node.characters;
    const textCase = isMixed(node.textCase) ? 'ORIGINAL' : (node.textCase as string);
    if (textCase === 'LOWER') text = text.toLowerCase();
    else if (textCase === 'TITLE') text = text.replace(/(^|\s)(\S)/g, (_m, space: string, letter: string) => space + letter.toUpperCase());
    const lines = text.split(/\r\n|\r|\n/).length;
    const size = sizeOf(node);

    let lineHeight: number;
    if (leading.unit === 'PIXELS') lineHeight = leading.value;
    else if (leading.unit === 'PERCENT') lineHeight = (fontSize * leading.value) / 100;
    // "Auto" is the font's own line height. A text that is as tall as its lines says what that is.
    else lineHeight = node.textAutoResize === 'WIDTH_AND_HEIGHT' && lines > 0 && size.y > 0 ? size.y / lines : fontSize * 1.2;

    const align = node.textAlignHorizontal === 'CENTER' ? 'center' : node.textAlignHorizontal === 'RIGHT' ? 'right' : node.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : 'left';
    const content: TextContent = {
      type: 'text',
      text,
      fontFamily: font.family,
      fontStyle: font.style,
      fontSize,
      align,
      tracking: r4(spacing.unit === 'PIXELS' ? (spacing.value / Math.max(1, fontSize)) * 1000 : spacing.value * 10),
      lineHeight: r4(lineHeight),
      // Without font metrics this is an estimate (the same one the builder makes the other way round); `ink` is exact.
      firstBaseline: { x: align === 'center' ? size.x / 2 : align === 'right' ? size.x : 0, y: r4(lineHeight / 2 + fontSize * 0.35) },
    };
    if (textCase === 'UPPER') content.caps = 'all';
    else if (textCase === 'SMALL_CAPS' || textCase === 'SMALL_CAPS_FORCED') content.caps = 'small';
    if (node.textAutoResize !== 'WIDTH_AND_HEIGHT') content.box = { x: 0, y: 0, w: size.x, h: size.y };

    let fade = 1;
    const paint = [...fills].reverse().find((p) => p && p.visible !== false && (p.opacity ?? 1) > 0);
    if (paint && paint.type === 'SOLID') {
      content.fill = { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: 1 };
      // After Effects' text colour has no opacity of its own: the layer takes it.
      fade = clamp01(paint.opacity ?? 1);
    } else if (paint) {
      content.fill = { r: 0, g: 0, b: 0, a: 1 };
      this.warn(node, 'The text is filled with a gradient or a picture; it arrives in black.');
    }
    const strokes = this.solids(node, 'strokes').paints;
    const weight = get<unknown>(node, 'strokeWeight');
    if (strokes.length && typeof weight === 'number' && weight > 0) {
      const c = strokes[0]!.color.v;
      content.stroke = { color: { r: c.r, g: c.g, b: c.b, a: 1 }, width: weight };
    }

    const fx = this.shadowOf(node);
    if (fx.other.length) this.warn(node, `The effect "${fx.other[0]}" is not transferred.`);
    // Where the glyphs are drawn, as long as the text is not turned and nothing else widens what Figma measures.
    const m = absOf(node);
    const bounds = get<{ x: number; y: number; width: number; height: number } | null>(node, 'absoluteRenderBounds');
    const upright = Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
    if (bounds && upright && !fx.shadow && !fx.other.length && !content.stroke && bounds.width > 0 && bounds.height > 0) {
      content.ink = { x: r4(bounds.x - m[4]), y: r4(bounds.y - m[5]), w: r4(bounds.width), h: r4(bounds.height) };
    }

    const extra: Partial<Layer> = {};
    const blend = this.blendOf(node);
    if (blend) extra.blendMode = blend;
    if (fx.shadow) extra.shadow = fx.shadow;
    const tracks = this.of(node).tracks;
    const own = clamp01(num(get(node, 'opacity'), 1));
    const keys = tracks.float('OPACITY', own);
    const opacity = anim(r4(own * fade), keys ? mapKeys(keys, (v) => r4(clamp01(v) * fade)) : null);
    return [this.layer(ctx, node.name, content, this.place(node, ctx, (s) => ({ x: s.x / 2, y: s.y / 2 }), { opacity }), extra)];
  }

  /** The node as a picture, exported by Figma: for what After Effects has no shape for. */
  private async picture(node: SceneNode, ctx: Ctx, why: string): Promise<Layer[]> {
    const bounds = get<{ x: number; y: number; width: number; height: number } | null>(node, 'absoluteRenderBounds');
    const exporter = get<(settings: ExportSettings) => Promise<Uint8Array>>(node, 'exportAsync');
    if (!bounds || !exporter || !(bounds.width > 0) || !(bounds.height > 0)) return [];
    const longest = Math.max(bounds.width, bounds.height);
    // Twice its size, so there is something to scale up with; less for something huge.
    const scale = Math.max(0.25, Math.min(2, 8192 / longest));
    let bytes: Uint8Array;
    try {
      bytes = await exporter.call(node, { format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    } catch {
      this.warn(node, `It has ${why}, which After Effects has no shape for, and Figma could not export it as a picture either; it is left out.`);
      return [];
    }
    const px = pngSize(bytes) ?? { w: Math.round(bounds.width * scale), h: Math.round(bounds.height * scale) };
    const assetId = `f${hashBytes(bytes)}`;
    if (!this.assets[assetId]) {
      this.assets[assetId] = { id: assetId, name: node.name, width: px.w, height: px.h, mime: 'image/png' };
      this.images[assetId] = bytes;
    }
    this.warn(node, `It has ${why}, which After Effects has no shape for, so it arrives as a picture.`, 'info');

    // The picture is upright on the page, whatever the node is turned by; its opacity and shadow are in its pixels.
    const tracks = this.of(node).tracks;
    const centre = at(absOf(node), { x: sizeOf(node).x / 2, y: sizeOf(node).y / 2 });
    const rest = num(get(node, 'opacity'), 1);
    const keys = tracks.float('OPACITY', rest);
    const opacity: Anim<number> = moves(keys) ? { v: 1, k: mapKeys(keys, (v) => clamp01(v / Math.max(0.01, rest))) } : { v: 1 };
    const transform = this.place(node, ctx, () => ({ x: centre.x - bounds.x, y: centre.y - bounds.y }), { opacity, rest: shift(centre.x - sizeOf(node).x / 2, centre.y - sizeOf(node).y / 2) });
    const extra: Partial<Layer> = {};
    const blend = this.blendOf(node);
    if (blend) extra.blendMode = blend;
    return [this.layer(ctx, node.name, { type: 'image', width: bounds.width, height: bounds.height, assetId }, transform, extra)];
  }

  // --------------------------------------------------------------- containers

  /** Whether something inside pokes out of the frame's (rounded) box. Frames inside that clip count as their own box. */
  private pokesOut(frame: SceneNode): boolean {
    const size = sizeOf(frame);
    const radius = num(get(frame, 'cornerRadius'), Math.max(...['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'].map((f) => num(get(frame, f), 0))));
    const back = inverse(absOf(frame));
    const check = (node: SceneNode): boolean => {
      for (const child of kidsOf(node)) {
        // A group is as large as what it holds.
        if (child.type === 'GROUP') {
          if (check(child)) return true;
          continue;
        }
        const s = sizeOf(child);
        const m = mul(back, absOf(child));
        const corners = [{ x: 0, y: 0 }, { x: s.x, y: 0 }, { x: s.x, y: s.y }, { x: 0, y: s.y }];
        if (corners.some((p) => !insideRounded(at(m, p), size.x, size.y, radius))) return true;
        if (CONTAINERS.has(child.type) && get<boolean>(child, 'clipsContent') !== true && check(child)) return true;
      }
      return false;
    };
    return check(frame);
  }

  /** A picture a frame is filled with: the whole picture as a layer, placed the way Figma crops it. The frame's composition cuts it off. */
  private async backdrop(node: SceneNode, paint: ImagePaint, ctx: Ctx): Promise<Layer | null> {
    if (!paint.imageHash) return null;
    const assetId = `p${paint.imageHash.slice(0, 24)}`;
    let asset = this.assets[assetId];
    if (!asset) {
      try {
        const image = figma.getImageByHash(paint.imageHash);
        if (!image) return null;
        const bytes = await image.getBytesAsync();
        const dims = await image.getSizeAsync();
        asset = { id: assetId, name: `${node.name} picture`, width: dims.width, height: dims.height, mime: mimeOf(bytes) };
        this.assets[assetId] = asset;
        this.images[assetId] = bytes;
      } catch {
        this.warn(node, 'The picture it is filled with could not be read from Figma; it is left out.');
        return null;
      }
    }
    const size = sizeOf(node);
    const iw = asset.width;
    const ih = asset.height;
    if (!(iw > 0) || !(ih > 0)) return null;
    // Picture pixels -> node space.
    let m: Mat;
    if (paint.scaleMode === 'CROP' && paint.imageTransform) {
      // Figma says where the node's box lies in the picture; we need the picture in the node's box.
      const t = fromFigma(paint.imageTransform);
      m = inverse(mul(mul([iw, 0, 0, ih, 0, 0], t), [1 / size.x, 0, 0, 1 / size.y, 0, 0]));
    } else if (paint.scaleMode === 'TILE') {
      const s = num(paint.scalingFactor, 1);
      m = [s, 0, 0, s, 0, 0];
      this.warn(node, 'The picture it is filled with is tiled; After Effects gets it once.', 'info');
    } else {
      const s = paint.scaleMode === 'FIT' ? Math.min(size.x / iw, size.y / ih) : Math.max(size.x / iw, size.y / ih);
      m = [s, 0, 0, s, (size.x - iw * s) / 2, (size.y - ih * s) / 2];
    }
    const full = mul(mul(ctx.toSpace, absOf(node)), m);
    const d = decompose(full);
    const middle = at(full, { x: iw / 2, y: ih / 2 });
    const transform: Transform = {
      anchor: { mode: 'vec', a: { v: { x: iw / 2, y: ih / 2 } } },
      position: { mode: 'vec', a: { v: middle } },
      scale: { mode: 'vec', a: { v: { x: d.sx, y: d.sy } } },
      rotation: { v: d.rotation },
      opacity: { v: clamp01(paint.opacity ?? 1) },
    };
    return this.layer(ctx, `${node.name} picture`, { type: 'image', width: iw, height: ih, assetId }, transform);
  }

  /** What a frame draws itself (its fills and strokes), as layers in the frame's own composition: front-most first. */
  private async ownLayers(node: SceneNode, ctx: Ctx): Promise<Layer[]> {
    const fills = this.solids(node, 'fills');
    const strokes = this.solids(node, 'strokes');
    for (const what of [...fills.other, ...(strokes.image ? ['a picture'] : []), ...strokes.other]) {
      this.warn(node, `It is filled or outlined with ${what}, which is not transferred; that part of its background is left out.`);
    }
    const layers: Layer[] = [];
    if (fills.paints.length || strokes.paints.length) {
      const { content, sizes } = this.box(node, fills.paints, strokes.paints, 'rect');
      layers.push(this.layer(ctx, 'Background', content, this.place(node, ctx, () => ({ x: 0, y: 0 }), { sizes, opacity: { v: 1 }, still: true })));
    }
    if (fills.image) {
      const picture = await this.backdrop(node, fills.image, ctx);
      // The picture lies over the plain colours, as it usually does in the list of fills.
      if (picture) layers.unshift(picture);
    }
    return layers;
  }

  /** The children of a frame or group, front-most first. A mask cuts out everything above it. */
  private async children(node: SceneNode, ctx: Ctx): Promise<Layer[]> {
    const stacks: Layer[][] = [];
    let matte = ctx.matte;
    for (const child of kidsOf(node)) {
      if (get<boolean>(child, 'isMask') === true) {
        const made = await this.node(child, { ...ctx, matte: undefined, asMask: true });
        const mask = made.length === 1 ? made[0]! : null;
        if (mask) {
          mask.hidden = true;
          delete mask.matte;
          if (ctx.matte) this.warn(child, 'It is a mask inside something that is masked already; After Effects layers take one matte, so only this one applies to what is above it.');
          matte = { layerId: mask.id };
          if (get<string>(child, 'maskType') === 'LUMINANCE') matte.luma = true;
        } else if (made.length) {
          this.warn(child, 'This mask could not be read as one layer; what it masks arrives unmasked.');
        }
        stacks.push(made);
        continue;
      }
      stacks.push(await this.node(child, { ...ctx, matte, asMask: false }));
    }
    return stacks.reverse().flat();
  }

  private async container(node: SceneNode, ctx: Ctx): Promise<Layer[]> {
    const info = this.of(node);
    const tracks = info.tracks;
    const kids = kidsOf(node);
    const size = sizeOf(node);
    const fills = this.solids(node, 'fills');
    const strokes = this.solids(node, 'strokes');
    const fx = this.shadowOf(node);
    const blend = this.blendOf(node);
    const background = fills.paints.length > 0 || strokes.paints.length > 0;
    const pieces = kids.length + (background ? 1 : 0);
    if (!pieces && !fills.image) return [];
    if (fx.other.length) this.warn(node, `The effect "${fx.other[0]}" on a frame or group is not transferred.`);

    const rest = clamp01(num(get(node, 'opacity'), 1));
    const fadeKeys = tracks.float('OPACITY', rest);
    // Its own opacity, or one handed down by a frame above that was dissolved into it.
    const fades = rest < 1 - 1e-4 || moves(fadeKeys) || !!ctx.opacity.k || ctx.opacity.v < 1 - 1e-4;
    const clips = get<boolean>(node, 'clipsContent') === true && kids.length > 0 && (info.movesInside || this.pokesOut(node));
    const alone =
      !!ctx.asMask ||
      clips ||
      !!fills.image ||
      // Several things that fade or blend as one, or cast one shadow: only a composition does that.
      ((fades || !!blend || !!ctx.blend) && pieces > 1) ||
      (!!fx.shadow && !background && kids.length > 1);

    if (alone) {
      const inner = this.newComp(node.name, size.x, size.y, ctx.comp.duration);
      const innerCtx: Ctx = { comp: inner, toSpace: inverse(absOf(node)), opacity: { v: 1 } };
      inner.layers = [...(await this.children(node, innerCtx)), ...(await this.ownLayers(node, innerCtx))];
      const extra: Partial<Layer> = {};
      if (blend) extra.blendMode = blend;
      if (fx.shadow) extra.shadow = fx.shadow;
      const layer = this.layer(ctx, node.name, { type: 'comp', compId: inner.id, width: inner.width, height: inner.height, startTime: 0 }, this.place(node, ctx, (s) => ({ x: s.x / 2, y: s.y / 2 })), extra);
      const radius = num(get(node, 'cornerRadius'), Math.max(...['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'].map((f) => num(get(node, f), 0))));
      if (clips && radius > 0 && !ctx.asMask) {
        if (layer.matte) {
          this.warn(node, 'It clips with rounded corners and sits under a mask; After Effects layers take one matte, so the corners are left square.', 'info');
        } else {
          // A composition clips to its rectangle; the rounded corners are a matte that follows the layer.
          const { content } = this.box(node, [{ color: { v: { r: 1, g: 1, b: 1, a: 1 } } }], [], 'rect');
          const clip = this.layer({ ...ctx, parentId: layer.id, matte: undefined, blend: undefined }, `${node.name} corners`, content, { ...identity(), position: { mode: 'vec', a: { v: { x: size.x / 2, y: size.y / 2 } } } }, { hidden: true });
          layer.matte = { layerId: clip.id };
          return [clip, layer];
        }
      }
      return [layer];
    }

    if (background) {
      // The frame's box is a shape layer; what is inside follows it.
      const { content, sizes } = this.box(node, fills.paints, strokes.paints, 'rect');
      const extra: Partial<Layer> = {};
      if (blend) extra.blendMode = blend;
      if (fx.shadow) extra.shadow = fx.shadow;
      const box = this.layer(ctx, node.name, content, this.place(node, ctx, () => ({ x: 0, y: 0 }), { sizes }), extra);
      const inside = await this.children(node, { comp: ctx.comp, toSpace: mul(shift(-size.x / 2, -size.y / 2), inverse(absOf(node))), parentId: box.id, matte: ctx.matte, opacity: { v: 1 } });
      return [...inside, box];
    }

    const below: Ctx = { ...ctx, asMask: false, opacity: this.fade(anim(rest, fadeKeys), ctx.opacity, tracks.fps) };
    if (blend && !below.blend) below.blend = blend;
    if (fx.shadow && kids.length === 1) this.warn(node, 'The shadow on this group is not transferred; put it on the layer inside.', 'info');
    if (tracks.transforms) {
      // Nothing to draw, but it moves: a null object carries the motion and what is inside follows it.
      const carrier = this.layer({ ...ctx, matte: undefined, blend: undefined }, node.name, { type: 'empty', width: size.x, height: size.y }, this.place(node, ctx, (s) => ({ x: s.x / 2, y: s.y / 2 }), { opacity: { v: 1 } }));
      const inside = await this.children(node, { ...below, toSpace: inverse(absOf(node)), parentId: carrier.id });
      return [...inside, carrier];
    }
    // A frame that only holds things: its children are layers of this composition.
    return this.children(node, below);
  }

  private async node(node: SceneNode, ctx: Ctx): Promise<Layer[]> {
    if (!visible(node)) return [];
    if (node.type === 'SLICE') return [];
    if (CONTAINERS.has(node.type)) return this.container(node, ctx);
    if (node.type === 'TEXT') return this.text(node, ctx);
    if (SHAPES.has(node.type)) {
      const why = this.drawable(node);
      return why ? this.picture(node, ctx, why) : this.shape(node, ctx);
    }
    return this.picture(node, ctx, 'a kind of layer');
  }

  /** One frame as a document. */
  async read(root: SceneNode): Promise<BridgeDoc> {
    this.rootName = root.name;
    const info = this.scan(root);
    const size = sizeOf(root);
    const timeline = get<ReadonlyArray<{ duration: number }>>(root, 'timelines')?.[0]?.duration;
    let reach = 0;
    for (const i of this.info.values()) reach = Math.max(reach, i.tracks.reach);
    // A frame nothing moves in has no length: After Effects gives it one.
    const animated = info.movesInside;
    const duration = animated ? r4(Math.max(num(timeline, 0), reach)) : 0;
    const comp = this.newComp(root.name, size.x, size.y, duration);
    const ctx: Ctx = { comp, toSpace: inverse(absOf(root)), opacity: { v: 1 } };

    if (CONTAINERS.has(root.type)) {
      comp.layers = [...(await this.children(root, ctx)), ...(await this.ownLayers(root, ctx))];
      const colour = this.solids(root, 'fills').paints;
      const back = colour[colour.length - 1]?.color.v;
      if (back) comp.background = { r: back.r, g: back.g, b: back.b, a: 1 };
    } else {
      // A single shape or text was selected: a composition of its size with it inside.
      comp.layers = await this.node(root, ctx);
    }
    return {
      format: FORMAT_NAME,
      version: FORMAT_VERSION,
      source: { app: 'figma', version: BRIDGE_VERSION, project: figma.root.name },
      rootCompId: comp.id,
      posterTime: 0,
      comps: this.comps,
      assets: this.assets,
      warnings: this.warnings,
    };
  }
}

function identity(): Transform {
  return { anchor: { mode: 'vec', a: { v: { x: 0, y: 0 } } }, position: { mode: 'vec', a: { v: { x: 0, y: 0 } } }, scale: { mode: 'vec', a: { v: { x: 1, y: 1 } } }, rotation: { v: 0 }, opacity: { v: 1 } };
}

/** A short fingerprint of a file's bytes: the same picture is the same asset. */
function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}${bytes.length.toString(36)}`;
}

function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const be = (o: number): number => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  return { w: be(16), h: be(20) };
}

function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/png';
}

/**
 * What of a selection can be sent: every selected layer that is not inside
 * another selected one, as long as it can be seen and has a size.
 */
export function pushable(selection: readonly SceneNode[]): SceneNode[] {
  const picked = new Set(selection.map((n) => n.id));
  return selection.filter((node) => {
    if (!visible(node) || node.type === 'SLICE') return false;
    const size = sizeOf(node);
    if (!(size.x >= 1) || !(size.y >= 1)) return false;
    for (let p = node.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p = p.parent) if (picked.has(p.id)) return false;
    return true;
  });
}

/** Reads each frame into a document of its own. Pictures used by several frames travel once. */
export async function readFrames(nodes: readonly SceneNode[], progress?: (done: number, total: number, name: string) => Promise<void>): Promise<ReadOutput> {
  const images: Record<string, Uint8Array> = {};
  const docs: BridgeDoc[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (progress) await progress(i, nodes.length, node.name);
    docs.push(await new Reader(images).read(node));
  }
  return { docs, images };
}
