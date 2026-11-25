/**
 * Rebuilds a bridge document as Figma nodes with Motion keyframes.
 *
 * The hard part is that the two applications think about transforms
 * differently:
 *
 *  - After Effects rotates and scales a layer around a freely placed anchor
 *    point. Figma's motion rotates and scales around the node's centre.
 *    When the two do not coincide, the layer is put inside an invisible
 *    "pivot" frame whose centre sits exactly on the anchor point, and that
 *    frame carries the motion.
 *
 *  - After Effects parenting passes on the transform but not the opacity,
 *    and does not touch the stacking order. Figma only has nesting. A parent
 *    whose children sit next to it in the layer stack becomes a frame that
 *    holds them ("rig"). When other layers sit in between, nesting would
 *    change what covers what, so each child instead gets its own copy of the
 *    parent's motion ("ghost" frames).
 *
 *  - A node that carries transform keyframes always rests un-rotated and
 *    un-scaled; the whole rotation and scale then live on the timeline. That
 *    keeps the result independent of how Figma combines a resting rotation
 *    with animated translation.
 *
 *  - A nested composition that a template switches between versions of (a
 *    logo per market, an end card per language) becomes a Figma component
 *    set: one variant per version, each with its own animation, and the layer
 *    that shows it becomes an instance. That keeps the frame as short as the
 *    After Effects timeline and lets a designer switch the option in Figma.
 *    Every component is built for the place it is used at, with that place's
 *    timing already in its keyframes, so an instance needs no time offset.
 *
 *  - A track matte becomes a Figma mask: the matted layers move into a frame
 *    whose lowest child is a copy of the matte layer, marked as mask.
 *
 *  - A composition that an expression holds on one frame is a picker (an
 *    image per frame, a control choosing the frame). It becomes a component
 *    set with one variant per picture.
 *
 *  - A component is recognised by what it shows, not by where it came from:
 *    two frames of one transfer that use the same composition with the same
 *    timing share one component, and a still one (a picker, an image) that is
 *    already on the page from an earlier transfer is used again.
 *
 *  - A still component (a picker's pictures, an image precomp) is kept at a
 *    reduced size, and every instance of it is scaled back up - the way a
 *    picture is placed at any size in Figma. That keeps large source images
 *    from taking over the page. A component with keyframes inside stays at
 *    full size: its keyframes are measured in its own pixels.
 *
 *  - Nothing is put on top of what is already on the page: new frames go
 *    below it in a row, and each frame's components are collected in a
 *    section well to the side of them ("arrange").
 */
import type {
  BlendMode as BridgeBlendMode,
  BridgeDoc,
  Comp,
  CompContent,
  CompSet,
  DropShadow,
  Element,
  EllipseContent,
  Key,
  Layer,
  PathContent,
  Rect,
  RectContent,
  RGBA,
  ShapeStyle,
  TextContent,
  Transform,
  Vec2,
} from '../../../shared/format.ts';
import { numOps, rgbaOps } from '../../../shared/anim.ts';
import { BRIDGE_VERSION } from '../../../shared/protocol.ts';
import { closedForFill, compoundSvg, pathsBounds, rotate, subPathToSvg, unionRects } from '../../../shared/geometry.ts';
import { FALLBACK_FONT, fontKey } from './fonts.ts';
import { MotionWriter } from './motion.ts';
import type { OpacityPlan, P, PVec, TimeCtx } from './prepare.ts';
import { frozenTime, mapPVec, nestTime, prep, prepOpacity, prepVec, pvAnimated, rootTime, timeKey } from './prepare.ts';

export interface BuildInput {
  doc: BridgeDoc;
  images: Record<string, Uint8Array>;
  fonts: Map<string, FontName>;
  /**
   * Build nested compositions as components and template options as
   * variants. When off, everything is built into the one frame and only the
   * current setting of each option is kept.
   */
  components?: boolean;
  /** What the other compositions of the same transfer have built (see newShared). */
  shared?: Shared;
  /** The images as Figma knows them (see imageHashes), when the caller has asked already. */
  hashes?: Map<string, string>;
  /**
   * A frame built from this composition before. The new layers are built into
   * it, so it stays the same frame, in the same place. What was in it is left
   * alone and handed back as `replaced`: the caller takes over what it wants
   * from it and removes it.
   */
  into?: FrameNode;
}

export interface BuildOutput {
  frame: FrameNode;
  /** With `into`: what the frame held before, still in it, below the new layers. */
  replaced: SceneNode[];
  /** Components and component sets made for the frame, the ones it uses directly first. */
  components: SceneNode[];
  /** Components the frame uses that another frame, or an earlier transfer, had already made. */
  reused: number;
  nodes: number;
  motion: MotionWriter;
  warnings: string[];
}

interface Stats {
  nodes: number;
  warnings: string[];
  /** Everything created so far, so a failed build leaves nothing behind. */
  created: SceneNode[];
}

interface ComponentBuilt {
  node: ComponentNode;
  hasTracks: boolean;
}

/**
 * The components of one transfer, by what they show (see Signer). Everything
 * that shows the same composition with the same timing uses the same one.
 */
export interface Shared {
  single: Map<string, ComponentBuilt>;
  /** Component sets: the variants by their number in the set. */
  sets: Map<string, Map<number, ComponentBuilt>>;
}

interface Library {
  enabled: boolean;
  shared: Shared;
  /** Top-level nodes to lay out next to the frame, with how deep in the frame they are used. */
  placed: Array<{ node: SceneNode; level: number }>;
  /** What this frame made itself, and what it took over from elsewhere. */
  own: Set<string>;
  borrowed: Set<string>;
}

interface Ctx {
  doc: BridgeDoc;
  images: Map<string, string>;
  fonts: Map<string, FontName>;
  tc: TimeCtx;
  motion: MotionWriter;
  stats: Stats;
  /**
   * A holding frame inside the top-level frame. New nodes wait here until
   * they are placed, because Figma only accepts keyframes on nodes that are
   * inside a top-level frame (that is where the timeline lives).
   */
  stage: FrameNode;
  depth: number;
  /** Stacking position of each layer of the composition being built (0 = front). */
  pos: Map<string, number>;
  /** Every layer of the composition being built, by id. */
  byId: Map<string, Layer>;
  library: Library;
  signer: Signer;
}

interface ContentBuilt {
  node: SceneNode | null;
  /** Bounds of the content in the element's own space, at rest. */
  bbox: Rect;
  hasTracks: boolean;
  /** The content already animates its own translation (to keep a resizing shape centred). */
  ownsTranslation: boolean;
}

interface Built {
  node: SceneNode;
  /** Bounds in the coordinates of the node it was appended to, at rest. */
  bbox: Rect;
  hasTracks: boolean;
  /** Nothing but a position was applied, so a parent may adopt the node as its own content. */
  plain: boolean;
  ownsTranslation: boolean;
}

interface TPlan {
  anchor: PVec;
  position: PVec;
  scale: PVec;
  rotation: P<number>;
  opacity: OpacityPlan;
}

interface TimeWindow {
  tin: number;
  tout: number;
}

const ZERO: Vec2 = { x: 0, y: 0 };
const EPS = 1e-4;

const BLEND: Record<BridgeBlendMode, BlendMode> = {
  normal: 'NORMAL',
  darken: 'DARKEN',
  multiply: 'MULTIPLY',
  'color-burn': 'COLOR_BURN',
  'linear-burn': 'LINEAR_BURN',
  lighten: 'LIGHTEN',
  screen: 'SCREEN',
  'color-dodge': 'COLOR_DODGE',
  'linear-dodge': 'LINEAR_DODGE',
  overlay: 'OVERLAY',
  'soft-light': 'SOFT_LIGHT',
  'hard-light': 'HARD_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const size = (n: number): number => Math.max(0.01, Math.abs(n));

function solid(c: RGBA): SolidPaint {
  return { type: 'SOLID', color: { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) }, opacity: clamp01(c.a) };
}

function made<T extends SceneNode>(node: T, ctx: Ctx): T {
  ctx.stats.nodes++;
  ctx.stats.created.push(node);
  ctx.stage.appendChild(node);
  return node;
}

function newFrame(name: string, w: number, h: number, ctx: Ctx): FrameNode {
  const f = made(figma.createFrame(), ctx);
  f.name = name;
  f.fills = [];
  f.clipsContent = false;
  f.resizeWithoutConstraints(size(w), size(h));
  return f;
}

// --------------------------------------------------------------- transforms

function planTransform(t: Transform, ctx: Ctx, window?: TimeWindow): TPlan {
  return {
    anchor: prepVec(t.anchor, ctx.tc),
    position: prepVec(t.position, ctx.tc),
    scale: prepVec(t.scale, ctx.tc),
    rotation: prep(t.rotation, numOps, ctx.tc),
    opacity: prepOpacity(t.opacity, window, ctx.tc),
  };
}

function scaleIsIdentity(scale: PVec): boolean {
  return scale.mode === 'static' && Math.abs(scale.rest.x - 1) < EPS && Math.abs(scale.rest.y - 1) < EPS;
}

function needsTransformTracks(plan: TPlan): boolean {
  return !scaleIsIdentity(plan.scale) || !!plan.rotation.keys || pvAnimated(plan.position);
}

/** Places a node at rest: its local origin lands on (tx, ty), turned clockwise by `degrees`. */
function setRest(node: SceneNode, tx: number, ty: number, degrees: number): void {
  if (Math.abs(degrees) < 1e-6) {
    node.x = tx;
    node.y = ty;
    return;
  }
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  (node as LayoutMixin).relativeTransform = [
    [c, -s, tx],
    [s, c, ty],
  ];
}

/** Axis-aligned bounds of a w x h box whose top-left sits at (tx, ty), turned by `degrees`. */
function turnedBounds(tx: number, ty: number, w: number, h: number, degrees: number): Rect {
  if (Math.abs(degrees) < 1e-6) return { x: tx, y: ty, w, h };
  const corners = [ZERO, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map((p) => rotate(p, degrees));
  const xs = corners.map((p) => p.x + tx);
  const ys = corners.map((p) => p.y + ty);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function applyTranslation(node: SceneNode, offset: PVec, ctx: Ctx): void {
  if (offset.mode === 'vec') {
    ctx.motion.vector(node, 'TRANSLATION_XY', 'TRANSLATION_X', 'TRANSLATION_Y', offset.keys);
  } else if (offset.mode === 'split') {
    if (offset.x) ctx.motion.float(node, 'TRANSLATION_X', offset.x);
    if (offset.y) ctx.motion.float(node, 'TRANSLATION_Y', offset.y);
  }
}

/**
 * Puts position, rotation and scale on the timeline of a node that rests
 * un-rotated at the plan's resting position.
 */
function applyTransformTracks(node: SceneNode, plan: TPlan, ctx: Ctx): void {
  const p0 = plan.position.rest;
  applyTranslation(node, mapPVec(plan.position, (x) => x - p0.x, (y) => y - p0.y), ctx);

  // After Effects turns clockwise, Figma counter-clockwise.
  if (plan.rotation.keys) {
    ctx.motion.float(node, 'ROTATION', plan.rotation.keys.map((k) => ({ ...k, v: -k.v })));
  } else if (Math.abs(plan.rotation.rest) > 1e-6) {
    ctx.motion.constant(node, 'ROTATION', -plan.rotation.rest);
  }

  const scale = plan.scale;
  if (scale.mode === 'vec') {
    ctx.motion.vector(node, 'SCALE_XY', 'SCALE_X', 'SCALE_Y', scale.keys);
  } else if (scale.mode === 'split') {
    if (scale.x) ctx.motion.float(node, 'SCALE_X', scale.x);
    else if (Math.abs(scale.rest.x - 1) > EPS) ctx.motion.constant(node, 'SCALE_X', scale.rest.x);
    if (scale.y) ctx.motion.float(node, 'SCALE_Y', scale.y);
    else if (Math.abs(scale.rest.y - 1) > EPS) ctx.motion.constant(node, 'SCALE_Y', scale.rest.y);
  } else if (!scaleIsIdentity(scale)) {
    ctx.motion.vector(node, 'SCALE_XY', 'SCALE_X', 'SCALE_Y', [{ t: 0, v: scale.rest }]);
  }
}

function applyOpacity(node: SceneNode, opacity: OpacityPlan, ctx: Ctx): void {
  if ('opacity' in node) node.opacity = clamp01(opacity.rest);
  if (opacity.keys) ctx.motion.float(node, 'OPACITY', opacity.keys.map((k) => ({ ...k, v: clamp01(k.v) })));
}

function applyBlend(node: SceneNode, mode: BridgeBlendMode | undefined): void {
  if (mode && mode !== 'normal' && 'blendMode' in node) node.blendMode = BLEND[mode];
}

interface TransformFrame {
  frame: FrameNode;
  /** Where children go (differs from `frame` when the anchor point is animated). */
  inner: FrameNode;
  /** Position of the element's own origin inside `inner`. */
  o: Vec2;
  bbox: Rect;
}

/**
 * An invisible frame that carries an element's transform. It is sized so its
 * centre lies on the anchor point (Figma's pivot) while still covering the
 * content, which keeps the pivot right however Figma measures the centre.
 */
function makeTransformFrame(
  name: string,
  plan: TPlan,
  contentBox: Rect,
  parent: FrameNode,
  origin: Vec2,
  ctx: Ctx,
  opacity?: OpacityPlan,
): TransformFrame {
  const a = plan.anchor.rest;
  const p0 = plan.position.rest;
  const halfW = Math.max(a.x - contentBox.x, contentBox.x + contentBox.w - a.x, 0.5);
  const halfH = Math.max(a.y - contentBox.y, contentBox.y + contentBox.h - a.y, 0.5);
  const frame = newFrame(name, halfW * 2, halfH * 2, ctx);
  parent.appendChild(frame);

  let bbox: Rect;
  if (needsTransformTracks(plan)) {
    frame.x = origin.x + p0.x - halfW;
    frame.y = origin.y + p0.y - halfH;
    applyTransformTracks(frame, plan, ctx);
    bbox = { x: frame.x, y: frame.y, w: halfW * 2, h: halfH * 2 };
  } else {
    const r0 = plan.rotation.rest;
    const corner = rotate({ x: -halfW, y: -halfH }, r0);
    const tx = origin.x + p0.x + corner.x;
    const ty = origin.y + p0.y + corner.y;
    setRest(frame, tx, ty, r0);
    bbox = turnedBounds(tx, ty, halfW * 2, halfH * 2, r0);
  }
  if (opacity) applyOpacity(frame, opacity, ctx);

  let inner = frame;
  if (pvAnimated(plan.anchor)) {
    // Moving the anchor point slides the content the opposite way under a fixed pivot.
    inner = newFrame(`${name} (anchor)`, halfW * 2, halfH * 2, ctx);
    frame.appendChild(inner);
    inner.x = 0;
    inner.y = 0;
    applyTranslation(inner, mapPVec(plan.anchor, (x) => -(x - a.x), (y) => -(y - a.y)), ctx);
  }
  return { frame, inner, o: { x: halfW - a.x, y: halfH - a.y }, bbox };
}

/** Applies an element's transform to its finished content and adds it to `parent`. */
function place(
  name: string,
  content: ContentBuilt,
  planIn: TPlan,
  parent: FrameNode,
  origin: Vec2,
  ctx: Ctx,
  blend: BridgeBlendMode | undefined,
): Built {
  const node = content.node!;
  let plan = planIn;
  let box = content.bbox;
  const a = plan.anchor.rest;
  const p0 = plan.position.rest;
  node.name = name;

  // A fixed, even scale is simply baked into the node's size - as long as
  // nothing inside it is measured in pixels on the timeline.
  if (plan.scale.mode === 'static' && !content.hasTracks && 'rescale' in node) {
    const s = plan.scale.rest;
    if (Math.abs(s.x - s.y) < EPS && s.x > EPS && Math.abs(s.x - 1) > EPS) {
      try {
        node.rescale(s.x);
        box = { x: a.x + (box.x - a.x) * s.x, y: a.y + (box.y - a.y) * s.x, w: box.w * s.x, h: box.h * s.x };
        plan = { ...plan, scale: { mode: 'static', rest: { x: 1, y: 1 } } };
      } catch {
        // Leave the scale to the timeline instead.
      }
    }
  }

  const anchorMoves = pvAnimated(plan.anchor);
  const tracked = needsTransformTracks(plan);
  const r0 = plan.rotation.rest;
  const hasTracks = content.hasTracks || tracked || anchorMoves || !!plan.opacity.keys;

  if (!tracked && !anchorMoves) {
    const corner = rotate({ x: box.x - a.x, y: box.y - a.y }, r0);
    const tx = origin.x + p0.x + corner.x;
    const ty = origin.y + p0.y + corner.y;
    parent.appendChild(node);
    setRest(node, tx, ty, r0);
    applyOpacity(node, plan.opacity, ctx);
    applyBlend(node, blend);
    const plain =
      Math.abs(r0) < 1e-6 && !plan.opacity.keys && Math.abs(plan.opacity.rest - 1) < EPS && (!blend || blend === 'normal');
    return {
      node,
      bbox: turnedBounds(tx, ty, box.w, box.h, r0),
      hasTracks,
      plain,
      ownsTranslation: content.ownsTranslation,
    };
  }

  const centred = Math.abs(box.x + box.w / 2 - a.x) < 0.05 && Math.abs(box.y + box.h / 2 - a.y) < 0.05;
  const pivotMatters = !scaleIsIdentity(plan.scale) || !!plan.rotation.keys || Math.abs(r0) > 1e-6;
  const translationClash = content.ownsTranslation && pvAnimated(plan.position);
  if (!anchorMoves && !translationClash && (centred || !pivotMatters)) {
    parent.appendChild(node);
    node.x = origin.x + p0.x - a.x + box.x;
    node.y = origin.y + p0.y - a.y + box.y;
    applyTransformTracks(node, plan, ctx);
    applyOpacity(node, plan.opacity, ctx);
    applyBlend(node, blend);
    return {
      node,
      bbox: { x: node.x, y: node.y, w: box.w, h: box.h },
      hasTracks: true,
      plain: false,
      ownsTranslation: content.ownsTranslation,
    };
  }

  const tf = makeTransformFrame(name, plan, box, parent, origin, ctx, plan.opacity);
  tf.inner.appendChild(node);
  node.x = tf.o.x + box.x;
  node.y = tf.o.y + box.y;
  applyBlend(tf.frame, blend);
  return { node: tf.frame, bbox: tf.bbox, hasTracks: true, plain: false, ownsTranslation: false };
}

function buildElement(
  el: Element,
  parent: FrameNode,
  origin: Vec2,
  ctx: Ctx,
  window?: TimeWindow,
): Built | null {
  const plan = planTransform(el.transform, ctx, window);
  if (plan.opacity.neverVisible) return null;
  const content = buildContent(el, ctx);
  if (!content.node) return null;
  // Before the transform, so the shadow grows and shrinks with the layer as it does in After Effects.
  if (el.shadow) applyShadow(content.node, el.shadow);
  return place(el.name, content, plan, parent, origin, ctx, el.blendMode);
}

function applyShadow(node: SceneNode, shadow: DropShadow): void {
  if (!('effects' in node)) return;
  try {
    node.effects = [
      {
        type: 'DROP_SHADOW',
        color: { r: clamp01(shadow.color.r), g: clamp01(shadow.color.g), b: clamp01(shadow.color.b), a: clamp01(shadow.color.a) },
        offset: { x: shadow.offset.x, y: shadow.offset.y },
        radius: Math.max(0, shadow.blur),
        spread: 0,
        visible: true,
        blendMode: 'NORMAL',
      },
    ];
  } catch {
    // A shadow is decoration: a node that refuses it is left without.
  }
}

// ------------------------------------------------------------------ content

function emptyBuilt(w: number, h: number): ContentBuilt {
  return { node: null, bbox: { x: 0, y: 0, w, h }, hasTracks: false, ownsTranslation: false };
}

function buildContent(el: Element, ctx: Ctx): ContentBuilt {
  const c = el.content;
  switch (c.type) {
    case 'empty':
      return emptyBuilt(c.width, c.height);
    case 'solid': {
      const r = made(figma.createRectangle(), ctx);
      r.resize(size(c.width), size(c.height));
      r.fills = [solid(c.color)];
      return { node: r, bbox: { x: 0, y: 0, w: c.width, h: c.height }, hasTracks: false, ownsTranslation: false };
    }
    case 'image': {
      const r = made(figma.createRectangle(), ctx);
      r.resize(size(c.width), size(c.height));
      const hash = ctx.images.get(c.assetId);
      if (hash) {
        r.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: hash }];
      } else {
        r.fills = [solid({ r: 0.5, g: 0.5, b: 0.5, a: 0.4 })];
        warn(ctx, `"${el.name}": the image could not be loaded; a grey placeholder is used.`);
      }
      return { node: r, bbox: { x: 0, y: 0, w: c.width, h: c.height }, hasTracks: false, ownsTranslation: false };
    }
    case 'comp':
      return buildCompContent(c, el.name, ctx);
    case 'group':
      return buildGroup(el.name, c.children, ctx);
    case 'rect':
    case 'ellipse':
      return buildPrimitive(c, ctx);
    case 'path':
      return buildPath(c, ctx);
    case 'text':
      return buildText(c, ctx);
  }
}

function warn(ctx: Ctx, message: string): void {
  if (ctx.stats.warnings.indexOf(message) === -1) ctx.stats.warnings.push(message);
}

function buildGroup(name: string, children: Element[], ctx: Ctx): ContentBuilt {
  const g = newFrame(name, 100, 100, ctx);
  const built: Built[] = [];
  for (let i = children.length - 1; i >= 0; i--) {
    const b = buildElement(children[i]!, g, ZERO, ctx);
    if (b) built.push(b);
  }
  if (!built.length) {
    g.remove();
    ctx.stats.nodes--;
    return emptyBuilt(0, 0);
  }
  if (built.length === 1 && built[0]!.plain) {
    // A group around one untouched node adds nothing: hand the node up.
    const only = built[0]!;
    ctx.stage.appendChild(only.node);
    g.remove();
    ctx.stats.nodes--;
    return { node: only.node, bbox: only.bbox, hasTracks: only.hasTracks, ownsTranslation: only.ownsTranslation };
  }
  const bb = unionRects(built.map((b) => b.bbox));
  for (const b of built) {
    b.node.x -= bb.x;
    b.node.y -= bb.y;
  }
  g.resizeWithoutConstraints(size(bb.w), size(bb.h));
  return { node: g, bbox: bb, hasTracks: built.some((b) => b.hasTracks), ownsTranslation: false };
}

function buildCompContent(c: CompContent, name: string, ctx: Ctx): ContentBuilt {
  const comp = ctx.doc.comps[c.compId];
  const tc = nestTime(ctx.tc, c.startTime, c.remap);
  const bbox: Rect = { x: 0, y: 0, w: c.width, h: c.height };

  // Compositions a template switches between, and the ones sitting directly
  // in the main composition, become components; anything deeper is part of
  // the component it sits in.
  const set = c.setId ? ctx.doc.sets?.[c.setId] : undefined;
  if (comp && ctx.library.enabled && ctx.depth < 12 && (set || ctx.depth === 0)) {
    const built = set ? variantOf(set, c, tc, ctx) : componentOf(comp, tc, ctx);
    if (built) {
      const instance = built.node.createInstance();
      ctx.stats.nodes++;
      ctx.stats.created.push(instance);
      ctx.stage.appendChild(instance);
      // A still component is kept smaller than the composition it shows (see shrinkStill): the
      // instance is brought back to full size. Measured, not remembered, so it is also right for a
      // component that was resized by hand since it was made.
      const kept = instance.width / size(c.width);
      if (!built.hasTracks && kept > EPS && Math.abs(kept - 1) > 1e-3) {
        try {
          instance.rescale(1 / kept);
        } catch (err) {
          warn(ctx, `"${name}": the instance could not be scaled to its size (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
      return { node: instance, bbox, hasTracks: built.hasTracks, ownsTranslation: false };
    }
  }

  const f = newFrame(name, c.width, c.height, ctx);
  f.clipsContent = true;
  let hasTracks = false;
  if (comp && ctx.depth < 12) {
    hasTracks = buildLayers(comp, f, { ...ctx, tc, depth: ctx.depth + 1, pos: new Map(), byId: new Map() });
  } else if (comp) {
    warn(ctx, `"${name}": compositions nested deeper than 12 levels are left empty.`);
  }
  return { node: f, bbox, hasTracks, ownsTranslation: false };
}

// --------------------------------------------------------------- components

function setTimelineLength(inside: SceneNode, seconds: number, ctx: Ctx): void {
  if (ctx.motion.available !== true) return;
  try {
    const timeline = inside.timelines[0];
    if (timeline) inside.setTimelineDuration(timeline.id, seconds);
  } catch (err) {
    const message = `The timeline length could not be set (${err instanceof Error ? err.message : String(err)}).`;
    if (ctx.motion.problems.indexOf(message) === -1) ctx.motion.problems.push(message);
  }
}

/**
 * Builds a composition as a main component. It is built as a top-level frame
 * of its own first - that is where Figma keeps a timeline - and then turned
 * into a component, the same way it is done by hand in Figma.
 */
function makeComponent(comp: Comp, name: string, tc: TimeCtx, ctx: Ctx): ComponentBuilt | null {
  const frame = figma.createFrame();
  ctx.stats.nodes++;
  ctx.stats.created.push(frame);
  frame.name = name;
  frame.fills = [];
  frame.clipsContent = true;
  frame.resizeWithoutConstraints(size(comp.width), size(comp.height));

  const stage = figma.createFrame();
  stage.name = 'Motion Bridge (building)';
  stage.fills = [];
  stage.clipsContent = false;
  frame.appendChild(stage);
  ctx.stats.created.push(stage);

  const hasTracks = buildLayers(comp, frame, { ...ctx, tc, stage, depth: ctx.depth + 1, pos: new Map(), byId: new Map() });
  stage.remove();
  if (hasTracks) setTimelineLength(frame.children[0] ?? frame, tc.duration, ctx);

  try {
    const node = figma.createComponentFromNode(frame);
    ctx.stats.created.push(node);
    return { node, hasTracks };
  } catch (err) {
    warn(ctx, `"${name}" could not be turned into a component (${err instanceof Error ? err.message : String(err)}); it is built into the frame instead.`);
    frame.remove();
    ctx.stats.nodes--;
    return null;
  }
}

// Plugin data on a component that can be used again: what it shows, and for a variant its number in the set.
const TAG = 'mbridge';
const TAG_VARIANT = 'mbridgeVariant';
/**
 * The same as TAG, on a component any transfer may not simply pick up (it has
 * keyframes inside, or stands alone where a set was meant). An update of the
 * design it was made for does use it again: what has not changed in After
 * Effects is then left untouched in Figma, with everything done to it there.
 */
const TAG_MOVING = 'mbridgeMoving';
/** On a component with keyframes inside (its instances are placed differently). */
const TAG_TRACKS = 'mbridgeTracks';
/** On every component, component set and section made here: an update may tidy these away, and nothing else. */
const TAG_MADE = 'mbridgeMade';

function tag(node: SceneNode, name: string, value: string): void {
  try {
    node.setPluginData(name, value);
  } catch {
    // Costs nothing but the chance to use the component again later.
  }
}

/** Whether a component, component set or section was made by a transfer (and not by a designer). */
export function madeHere(node: SceneNode): boolean {
  try {
    if (node.getPluginData(TAG_MADE) || node.getPluginData(TAG) || node.getPluginData(TAG_MOVING)) return true;
    if (node.type === 'COMPONENT') return node.getPluginData(TAG_VARIANT) !== '';
    if (node.type === 'COMPONENT_SET') return node.children.some((c) => c.getPluginData(TAG_VARIANT) !== '');
    // Sections made before they were marked are known by their name.
    return node.type === 'SECTION' && / · Components$/.test(node.name);
  } catch {
    return false;
  }
}

export function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b + c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * Says what a composition shows, as a short text that is the same for two
 * compositions exactly when they show the same thing - whatever they are
 * called in the transfer they came in. (Ids differ from transfer to transfer;
 * layers, timing, nested compositions and the images themselves do not.)
 */
class Signer {
  private readonly doc: BridgeDoc;
  private readonly images: Map<string, string>;
  private readonly memo = new Map<string, string>();

  constructor(doc: BridgeDoc, images: Map<string, string>) {
    this.doc = doc;
    this.images = images;
  }

  comp(id: string): string {
    const known = this.memo.get(`c${id}`);
    if (known) return known;
    const comp = this.doc.comps[id];
    if (!comp) return 'missing';
    // A composition that (wrongly) contains itself ends here instead of going round for ever.
    this.memo.set(`c${id}`, 'loop');
    const out = hashText(JSON.stringify({ ...comp, id: '' }, (_key, value: unknown) => this.swap(value)));
    this.memo.set(`c${id}`, out);
    return out;
  }

  set(id: string): string {
    const known = this.memo.get(`s${id}`);
    if (known) return known;
    const set = this.doc.sets?.[id];
    if (!set) return 'missing';
    const out = hashText(JSON.stringify({ n: set.name, p: set.props, v: set.variants.map((v) => [this.comp(v.compId), v.choice, v.at ?? null]) }));
    this.memo.set(`s${id}`, out);
    return out;
  }

  /** References by id are replaced by what they point at. */
  private swap(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const v = value as { type?: string; compId?: unknown; setId?: unknown; assetId?: unknown };
    if (v.type === 'comp' && typeof v.compId === 'string') {
      return { ...v, compId: this.comp(v.compId), setId: typeof v.setId === 'string' ? this.set(v.setId) : undefined };
    }
    if (v.type === 'image' && typeof v.assetId === 'string') {
      return { ...v, assetId: this.images.get(v.assetId) ?? `missing ${this.doc.assets[v.assetId]?.name ?? ''}` };
    }
    return value;
  }
}

/**
 * A fresh register of components for one transfer. With `fromPage`, still
 * components that an earlier transfer left on this page are entered too, so
 * the same picker or image is not built a second time. With `moving` (an
 * update), so is every other component a transfer made: one that still shows
 * what After Effects has is kept instead of being built again.
 */
export function newShared(fromPage = false, moving = false): Shared {
  const shared: Shared = { single: new Map(), sets: new Map() };
  if (!fromPage) return shared;
  try {
    const numbered = (node: SceneNode): number | null => {
      const index = node.getPluginData(TAG_VARIANT);
      return index !== '' && isFinite(Number(index)) ? Number(index) : null;
    };
    const entry = (node: ComponentNode): ComponentBuilt => ({ node, hasTracks: node.getPluginData(TAG_TRACKS) === '1' });
    /** Versions of a set that stand on the page by themselves. */
    const loose = new Map<string, Map<number, ComponentBuilt>>();
    for (const node of figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })) {
      const key = node.getPluginData(TAG) || (moving ? node.getPluginData(TAG_MOVING) : '');
      if (!key || node.removed) continue;
      if (node.type === 'COMPONENT') {
        const index = numbered(node);
        if (key.indexOf('s:') !== 0) {
          if (!shared.single.has(key)) shared.single.set(key, entry(node));
        } else if (index !== null) {
          const group = loose.get(key) ?? new Map<number, ComponentBuilt>();
          if (!group.has(index)) group.set(index, entry(node));
          loose.set(key, group);
        }
        continue;
      }
      const variants = new Map<number, ComponentBuilt>();
      for (const child of node.children) {
        if (child.type !== 'COMPONENT') continue;
        const index = numbered(child);
        if (index !== null) variants.set(index, entry(child));
      }
      if (variants.size && !shared.sets.has(key)) shared.sets.set(key, variants);
    }
    for (const [key, group] of loose) if (!shared.sets.has(key)) shared.sets.set(key, group);
  } catch {
    // Nothing to use again; everything is built fresh.
  }
  return shared;
}

/** The longer side a still component is kept at. */
const STILL_SIDE = 1000;

/**
 * Scales still components down to a handy size. Nothing is lost: a picture
 * keeps its full resolution inside, and instances are scaled back up.
 */
function shrinkStill(nodes: ComponentNode[]): void {
  if (!nodes.length) return;
  const longest = Math.max(...nodes.map((n) => Math.max(n.width, n.height)));
  const k = STILL_SIDE / longest;
  // Not worth it for a small difference.
  if (!(k < 0.8)) return;
  for (const n of nodes) {
    try {
      n.rescale(k);
    } catch {
      // Stays at full size; its instances are measured against it either way.
      return;
    }
  }
}

function borrow(key: string, ctx: Ctx): void {
  if (!ctx.library.own.has(key)) ctx.library.borrowed.add(key);
}

function componentOf(comp: Comp, tc: TimeCtx, ctx: Ctx): ComponentBuilt | null {
  const key = `c:${ctx.signer.comp(comp.id)}|${timeKey(tc)}|${Math.round(tc.poster * 1000)}`;
  const known = ctx.library.shared.single.get(key);
  if (known && !known.node.removed) {
    borrow(key, ctx);
    return known;
  }
  const built = makeComponent(comp, comp.name, tc, ctx);
  if (!built) return null;
  ctx.library.shared.single.set(key, built);
  ctx.library.own.add(key);
  tag(built.node, TAG_MADE, '1');
  if (!built.hasTracks) {
    shrinkStill([built.node]);
    // Only a still component is safe to pick up again in a later transfer.
    tag(built.node, TAG, key);
  } else {
    tag(built.node, TAG_MOVING, key);
    tag(built.node, TAG_TRACKS, '1');
  }
  ctx.library.placed.push({ node: built.node, level: ctx.depth });
  return built;
}

const VARIANT_GAP = 48;

/**
 * How many columns make a tidy block of `nodes`: about one and a half times
 * as wide as it is tall, and preferably without a ragged last row.
 */
function columnsFor(nodes: SceneNode[], gap: number): number {
  const n = nodes.length;
  const cw = Math.max(...nodes.map((node) => node.width));
  const ch = Math.max(...nodes.map((node) => node.height));
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = cols * (cw + gap) + gap;
    const h = rows * (ch + gap) + gap;
    const score = Math.abs(Math.log(w / h / 1.5)) + (cols * rows - n) / n;
    if (score < bestScore - 1e-9) {
      best = cols;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Puts nodes in rows and columns with `gap` around each. A column is as wide
 * and a row as tall as its largest member, so nodes of different sizes never
 * overlap. Returns the size of the whole grid.
 */
function gridLayout(nodes: SceneNode[], gap: number): { w: number; h: number } {
  const perRow = columnsFor(nodes, gap);
  const colW: number[] = [];
  const rowH: number[] = [];
  nodes.forEach((n, i) => {
    const c = i % perRow;
    const r = Math.floor(i / perRow);
    colW[c] = Math.max(colW[c] ?? 0, n.width);
    rowH[r] = Math.max(rowH[r] ?? 0, n.height);
  });
  const colX: number[] = [];
  const rowY: number[] = [];
  let x = gap;
  let y = gap;
  colW.forEach((w, c) => {
    colX[c] = x;
    x += w + gap;
  });
  rowH.forEach((h, r) => {
    rowY[r] = y;
    y += h + gap;
  });
  nodes.forEach((n, i) => {
    n.x = colX[i % perRow]!;
    n.y = rowY[Math.floor(i / perRow)]!;
  });
  return { w: x, h: y };
}

/** Builds every version of a set and joins them into one component set. */
function buildSet(set: CompSet, key: string, frozen: boolean, tc: TimeCtx, ctx: Ctx): Map<number, ComponentBuilt> {
  const variants = new Map<number, ComponentBuilt>();
  const nodes: ComponentNode[] = [];
  set.variants.forEach((v, index) => {
    const comp = ctx.doc.comps[v.compId];
    if (!comp) return;
    const name = set.props.map((p, i) => `${p.name}=${p.values[v.choice[i] ?? 0] ?? ''}`).join(', ');
    // A picker's version is the composition held on the frame that shows it.
    const built = makeComponent(comp, name, v.at === undefined ? tc : frozenTime(tc, v.at), ctx);
    if (!built) return;
    variants.set(index, built);
    nodes.push(built.node);
    tag(built.node, TAG_VARIANT, String(index));
    tag(built.node, TAG_MADE, '1');
    if (built.hasTracks) tag(built.node, TAG_TRACKS, '1');
  });
  const allStill = [...variants.values()].every((v) => !v.hasTracks);
  const still = frozen && allStill;
  if (allStill) shrinkStill(nodes);
  if (nodes.length > 1) {
    try {
      // Laid out in rows before they are joined, so the set comes out tidy.
      gridLayout(nodes, VARIANT_GAP);
      const joined = figma.combineAsVariants(nodes, figma.currentPage);
      joined.name = set.name;
      const grid = gridLayout(nodes, VARIANT_GAP);
      joined.resizeWithoutConstraints(grid.w, grid.h);
      gridLayout(nodes, VARIANT_GAP);
      tag(joined, still ? TAG : TAG_MOVING, key);
      tag(joined, TAG_MADE, '1');
      ctx.stats.created.push(joined);
      ctx.stats.nodes++;
      ctx.library.placed.push({ node: joined, level: ctx.depth });
    } catch (err) {
      warn(ctx, `The versions of "${set.name}" could not be joined into one component set (${err instanceof Error ? err.message : String(err)}); they are separate components.`);
      nodes.forEach((n) => {
        n.name = `${set.name} / ${n.name}`;
        tag(n, TAG_MOVING, key);
        ctx.library.placed.push({ node: n, level: ctx.depth });
      });
    }
  } else if (nodes.length === 1) {
    nodes[0]!.name = set.name;
    tag(nodes[0]!, TAG_MOVING, key);
    ctx.library.placed.push({ node: nodes[0]!, level: ctx.depth });
  }
  return variants;
}

/** The variant of a set that the layer shows. The whole set is built on first use. */
function variantOf(set: CompSet, c: CompContent, tc: TimeCtx, ctx: Ctx): ComponentBuilt | null {
  const index = c.variant ?? set.variants.findIndex((v) => v.compId === c.compId);
  if (index < 0 || !set.variants[index]) return null;
  // Versions held on a frame look the same whenever they are shown: one set serves every frame.
  const frozen = set.variants.every((v) => v.at !== undefined);
  const key = `s:${ctx.signer.set(set.id)}|${frozen ? 'still' : `${timeKey(tc)}|${Math.round(tc.poster * 1000)}`}`;
  const known = ctx.library.shared.sets.get(key)?.get(index);
  if (known && !known.node.removed) {
    borrow(key, ctx);
    return known;
  }
  const variants = buildSet(set, key, frozen, tc, ctx);
  ctx.library.shared.sets.set(key, variants);
  ctx.library.own.add(key);
  return variants.get(index) ?? null;
}

/** Fills, strokes and the modifiers that Figma keeps on the shape itself. Returns whether anything was keyframed. */
function applyStyle(node: RectangleNode | EllipseNode | VectorNode, style: ShapeStyle, ctx: Ctx): boolean {
  const tracksBefore = ctx.motion.tracks;

  // Figma lists paints back to front.
  const fills = style.fills.map((p) => prep(p.color, rgbaOps, ctx.tc)).reverse();
  node.fills = fills.map((p) => solid(p.rest));
  fills.forEach((p, index) => {
    if (p.keys) ctx.motion.color(node, 'fills', index, p.keys);
  });

  const strokes = style.strokes.map((p) => prep(p.color, rgbaOps, ctx.tc)).reverse();
  node.strokes = strokes.map((p) => solid(p.rest));
  if (strokes.length) {
    const width = prep(style.strokeWidth ?? { v: 1 }, numOps, ctx.tc);
    node.strokeWeight = Math.max(0, width.rest);
    node.strokeAlign = 'CENTER';
    try {
      node.strokeCap = style.cap === 'round' ? 'ROUND' : style.cap === 'square' ? 'SQUARE' : 'NONE';
      node.strokeJoin = style.join === 'round' ? 'ROUND' : style.join === 'bevel' ? 'BEVEL' : 'MITER';
      if (style.miterLimit !== undefined) node.strokeMiterLimit = Math.max(1, style.miterLimit);
      if (style.dashes && style.dashes.length) node.dashPattern = style.dashes.map((d) => Math.max(0, d));
    } catch {
      // Caps and joins are cosmetic; a node type that refuses them keeps its defaults.
    }
    strokes.forEach((p, index) => {
      if (p.keys) ctx.motion.color(node, 'strokes', index, p.keys);
    });
    if (width.keys) ctx.motion.float(node, 'STROKE_WEIGHT', width.keys.map((k) => ({ ...k, v: Math.max(0, k.v) })));
  }

  if (style.trim) {
    const offset = prep(style.trim.offset, numOps, ctx.tc);
    if (offset.keys) warn(ctx, `"${node.name}": an animated Trim Paths offset is not transferred.`);
    const shift = offset.rest;
    const start = prep(style.trim.start, numOps, ctx.tc);
    const end = prep(style.trim.end, numOps, ctx.tc);
    const fits = (v: number): boolean => v + shift >= -EPS && v + shift <= 1 + EPS;
    const all = [start.rest, end.rest, ...(start.keys ?? []).map((k) => k.v), ...(end.keys ?? []).map((k) => k.v)];
    const useShift = Math.abs(shift) > EPS && all.every(fits);
    if (Math.abs(shift) > EPS && !useShift) {
      warn(ctx, `"${node.name}": the Trim Paths offset wraps around the end of the path, which Figma cannot do; the offset is ignored.`);
    }
    const at = (v: number): number => clamp01(v + (useShift ? shift : 0));
    if (start.keys) ctx.motion.float(node, 'PATH_TRIM_START', start.keys.map((k) => ({ ...k, v: at(k.v) })));
    else if (at(start.rest) > EPS) ctx.motion.constant(node, 'PATH_TRIM_START', at(start.rest));
    if (end.keys) ctx.motion.float(node, 'PATH_TRIM_END', end.keys.map((k) => ({ ...k, v: at(k.v) })));
    else if (at(end.rest) < 1 - EPS) ctx.motion.constant(node, 'PATH_TRIM_END', at(end.rest));
  }

  if (style.cornerRadius && node.type !== 'ELLIPSE') {
    const radius = prep(style.cornerRadius, numOps, ctx.tc);
    try {
      node.cornerRadius = Math.max(0, radius.rest);
      if (radius.keys) ctx.motion.float(node, 'CORNER_RADIUS', radius.keys.map((k) => ({ ...k, v: Math.max(0, k.v) })));
    } catch {
      // Not every node type takes a corner radius.
    }
  }
  return ctx.motion.tracks > tracksBefore;
}

function buildPrimitive(c: RectContent | EllipseContent, ctx: Ctx): ContentBuilt {
  const dims = prepVec(c.size, ctx.tc);
  const w0 = size(dims.rest.x);
  const h0 = size(dims.rest.y);
  const node = made(c.type === 'rect' ? figma.createRectangle() : figma.createEllipse(), ctx);
  node.resize(w0, h0);
  const tracksBefore = ctx.motion.tracks;
  let ownsTranslation = false;

  if (c.type === 'rect' && node.type === 'RECTANGLE') {
    const fits = (r: number): number => Math.max(0, Math.min(r, w0 / 2, h0 / 2));
    if (c.radii) {
      const corners = [
        ['topLeftRadius', 'RECTANGLE_TOP_LEFT_CORNER_RADIUS'],
        ['topRightRadius', 'RECTANGLE_TOP_RIGHT_CORNER_RADIUS'],
        ['bottomRightRadius', 'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS'],
        ['bottomLeftRadius', 'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS'],
      ] as const;
      corners.forEach(([field, track], i) => {
        const radius = prep(c.radii![i]!, numOps, ctx.tc);
        node[field] = fits(radius.rest);
        if (radius.keys) ctx.motion.float(node, track, radius.keys.map((k) => ({ ...k, v: Math.max(0, k.v) })));
      });
    } else {
      const radius = prep(c.radius, numOps, ctx.tc);
      node.cornerRadius = fits(radius.rest);
      if (radius.keys) ctx.motion.float(node, 'CORNER_RADIUS', radius.keys.map((k) => ({ ...k, v: Math.max(0, k.v) })));
    }
  }

  // Figma grows a node from its top-left corner, After Effects from the
  // shape's centre: move it back by half of what it grows.
  const axis = (
    keys: Key<number>[],
    rest: number,
    sizeField: 'WIDTH' | 'HEIGHT',
    moveField: 'TRANSLATION_X' | 'TRANSLATION_Y',
    scaleField: 'SCALE_X' | 'SCALE_Y',
  ): void => {
    const problems = ctx.motion.problems.length;
    if (ctx.motion.float(node, sizeField, keys.map((k) => ({ ...k, v: size(k.v) })))) {
      ctx.motion.float(node, moveField, keys.map((k) => ({ ...k, v: -(size(k.v) - rest) / 2 })));
      ownsTranslation = true;
    } else if (ctx.motion.available !== false) {
      // Size cannot be keyframed on this node type: scale it around its centre instead.
      ctx.motion.problems.length = problems;
      ctx.motion.float(node, scaleField, keys.map((k) => ({ ...k, v: size(k.v) / rest })));
    }
  };
  if (dims.mode === 'vec') {
    axis(dims.keys.map((k) => ({ ...k, v: k.v.x })), w0, 'WIDTH', 'TRANSLATION_X', 'SCALE_X');
    axis(dims.keys.map((k) => ({ ...k, v: k.v.y })), h0, 'HEIGHT', 'TRANSLATION_Y', 'SCALE_Y');
  } else if (dims.mode === 'split') {
    if (dims.x) axis(dims.x, w0, 'WIDTH', 'TRANSLATION_X', 'SCALE_X');
    if (dims.y) axis(dims.y, h0, 'HEIGHT', 'TRANSLATION_Y', 'SCALE_Y');
  }

  applyStyle(node, c.style, ctx);
  return {
    node,
    bbox: { x: -w0 / 2, y: -h0 / 2, w: w0, h: h0 },
    hasTracks: ctx.motion.tracks > tracksBefore,
    ownsTranslation,
  };
}

function buildPath(c: PathContent, ctx: Ctx): ContentBuilt {
  const bounds = pathsBounds(c.paths);
  const node = made(figma.createVector(), ctx);
  // Path data is written relative to the bounds so the node's origin is its top-left corner.
  if (c.style.fills.length) {
    // A filled shape is ONE path with all its outlines in it: Figma only lets
    // an outline cut a hole into another one of the same path. (Handing every
    // outline over as a path of its own fills the counters of letters.)
    const outlines = c.paths.map((sp) => closedForFill(sp, c.style.strokes.length > 0));
    node.vectorPaths = [
      {
        windingRule: c.style.fillRule === 'evenodd' ? 'EVENODD' : 'NONZERO',
        data: compoundSvg(outlines, -bounds.x, -bounds.y),
      },
    ];
  } else {
    node.vectorPaths = c.paths
      .filter((sp) => sp.v.length > 0)
      .map((sp) => ({ windingRule: 'NONE' as const, data: subPathToSvg(sp, -bounds.x, -bounds.y) }));
  }
  const hasTracks = applyStyle(node, c.style, ctx);
  return { node, bbox: bounds, hasTracks, ownsTranslation: false };
}

function buildText(c: TextContent, ctx: Ctx): ContentBuilt {
  const font = ctx.fonts.get(fontKey(c.fontFamily, c.fontStyle)) ?? FALLBACK_FONT;
  const t = made(figma.createText(), ctx);
  t.fontName = font;
  t.characters = c.text;
  t.fontSize = Math.max(1, c.fontSize);
  t.lineHeight = { value: Math.max(1, c.lineHeight), unit: 'PIXELS' };
  t.letterSpacing = { value: c.tracking / 10, unit: 'PERCENT' };
  t.textAlignHorizontal =
    c.align === 'center' ? 'CENTER' : c.align === 'right' ? 'RIGHT' : c.align === 'justify' ? 'JUSTIFIED' : 'LEFT';
  if (c.caps === 'all') t.textCase = 'UPPER';
  else if (c.caps === 'small') t.textCase = 'SMALL_CAPS';
  t.fills = c.fill ? [solid(c.fill)] : [];
  if (c.stroke) {
    t.strokes = [solid(c.stroke.color)];
    t.strokeWeight = c.stroke.width;
    try {
      t.strokeAlign = 'CENTER';
    } catch {
      // Keeps Figma's default alignment.
    }
  }

  // With the box trimmed to cap height, its bottom edge is the last baseline.
  // That lets the text be placed on After Effects' baseline without knowing the font's metrics.
  let trimmed = false;
  try {
    t.leadingTrim = 'CAP_HEIGHT';
    trimmed = true;
  } catch {
    trimmed = false;
  }
  if (c.box) {
    t.textAutoResize = 'HEIGHT';
    t.resize(size(c.box.w), size(t.height));
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  const w = t.width;
  const h = t.height;
  let top: number;
  if (trimmed) {
    let cap = h - Math.floor((h + 0.01) / c.lineHeight) * c.lineHeight;
    if (!(cap > c.fontSize * 0.3 && cap < c.lineHeight)) cap = c.fontSize * 0.7;
    top = c.firstBaseline.y - cap;
  } else {
    top = c.firstBaseline.y - (c.lineHeight / 2 + c.fontSize * 0.35);
  }
  let left: number;
  if (c.box) left = c.box.x;
  else if (c.align === 'center') left = c.firstBaseline.x - w / 2;
  else if (c.align === 'right') left = c.firstBaseline.x - w;
  else left = c.firstBaseline.x;

  return { node: t, bbox: { x: left, y: top, w, h }, hasTracks: false, ownsTranslation: false };
}

// ------------------------------------------------------------------- layers

interface Unit {
  /** Stacking position of the unit's front-most layer. */
  front: number;
  kind: 'single' | 'rig';
  layer: Layer;
  /** Parents whose motion is copied around this unit, outermost first. */
  ghosts: Layer[];
  /** For a rig: every layer below it in the parent tree. */
  members: Layer[];
}

/**
 * Decides, for a set of layers that share a container, which parents can hold
 * their children as a nested frame and which children need a copy of their
 * parent's motion instead.
 */
function planUnits(
  members: Layer[],
  pos: Map<string, number>,
  ownFront?: number,
  byId?: Map<string, Layer>,
  applied?: Set<string>,
): Unit[] {
  const ids = new Set(members.map((m) => m.id));
  const kids = new Map<string, Layer[]>();
  const tops: Layer[] = [];
  for (const m of members) {
    if (m.parentId !== undefined && ids.has(m.parentId) && m.parentId !== m.id) {
      const list = kids.get(m.parentId);
      if (list) list.push(m);
      else kids.set(m.parentId, [m]);
    } else {
      tops.push(m);
    }
  }
  // A layer whose parent is built somewhere else (outside this container, as
  // happens around a track matte) gets a copy of that parent's motion - unless
  // the container already is that parent (`applied`).
  const outsideParents = (l: Layer): Layer[] => {
    const chain: Layer[] = [];
    let id = l.parentId;
    const guard = new Set<string>([l.id]);
    while (id !== undefined && byId && !ids.has(id) && !guard.has(id) && !applied?.has(id)) {
      const parent = byId.get(id);
      if (!parent) break;
      guard.add(id);
      chain.unshift(parent);
      id = parent.parentId;
    }
    return chain;
  };
  const at = (l: Layer): number => pos.get(l.id) ?? 0;
  const below = (l: Layer, out: Layer[], guard: Set<string>): Layer[] => {
    for (const k of kids.get(l.id) ?? []) {
      if (guard.has(k.id)) continue;
      guard.add(k.id);
      out.push(k);
      below(k, out, guard);
    }
    return out;
  };
  // Positions are compared within this container only. A rig's own picture
  // occupies a slot too: children may not be nested across it.
  const slots = members.map(at);
  if (ownFront !== undefined) slots.push(ownFront);
  slots.sort((a, b) => a - b);
  const rank = new Map<string, number>();
  for (const m of members) rank.set(m.id, slots.indexOf(at(m)));

  const units: Unit[] = [];
  const visit = (l: Layer, ghosts: Layer[]): void => {
    const desc = below(l, [], new Set([l.id]));
    if (!desc.length) {
      units.push({ front: at(l), kind: 'single', layer: l, ghosts, members: [] });
      return;
    }
    const ranks = [l, ...desc].map((x) => rank.get(x.id) ?? 0);
    const lo = Math.min(...ranks);
    const hi = Math.max(...ranks);
    if (hi - lo + 1 === ranks.length) {
      units.push({ front: Math.min(...[l, ...desc].map(at)), kind: 'rig', layer: l, ghosts, members: desc });
      return;
    }
    units.push({ front: at(l), kind: 'single', layer: l, ghosts, members: [] });
    for (const k of kids.get(l.id) ?? []) visit(k, [...ghosts, l]);
  };
  for (const t of tops) visit(t, outsideParents(t));
  return units;
}

function sizeHint(l: Layer, ctx: Ctx): Rect {
  const c = l.content;
  if (c.type === 'empty' || c.type === 'solid' || c.type === 'image' || c.type === 'comp') {
    return { x: 0, y: 0, w: c.width, h: c.height };
  }
  const a = prepVec(l.transform.anchor, ctx.tc).rest;
  return { x: a.x - 50, y: a.y - 50, w: 100, h: 100 };
}

interface Step {
  front: number;
  run: () => void;
}

function emit(
  members: Layer[],
  container: FrameNode,
  origin: Vec2,
  ctx: Ctx,
  own?: Step,
  others: Step[] = [],
  applied: Set<string> = new Set(),
): void {
  const steps: Step[] = planUnits(members, ctx.pos, own?.front, ctx.byId, applied).map((u) => ({
    front: u.front,
    run: () => {
      buildUnit(u, container, origin, ctx, false, applied);
    },
  }));
  if (own) steps.push(own);
  steps.push(...others);
  // Figma stacks later children on top, so build back to front.
  steps.sort((a, b) => b.front - a.front);
  for (const s of steps) s.run();
}

/**
 * Builds one unit. Returns the node that ended up directly in `container`
 * for a single layer (its outermost ghost frame, if it has any).
 * `force` builds a layer that is not drawn itself: a matte.
 */
function buildUnit(
  u: Unit,
  container: FrameNode,
  origin: Vec2,
  ctx: Ctx,
  force = false,
  applied: Set<string> = new Set(),
): SceneNode | null {
  let parent = container;
  let o = origin;
  let outer: SceneNode | null = null;
  for (const g of u.ghosts) {
    const tf = makeTransformFrame(`${g.name} › ${u.layer.name}`, planTransform(g.transform, ctx), sizeHint(g, ctx), parent, o, ctx);
    if (!outer) outer = tf.frame;
    parent = tf.inner;
    o = tf.o;
  }
  const L = u.layer;
  const window: TimeWindow = { tin: L.inPoint, tout: L.outPoint };

  if (u.kind === 'single') {
    if (L.hidden && !force) return null;
    const built = buildElement(L, parent, o, ctx, window);
    if (!built) {
      if (outer) {
        outer.remove();
        ctx.stats.nodes--;
      }
      return null;
    }
    return outer ?? built.node;
  }

  // A rig: the frame carries the parent's transform, the parent's own picture
  // sits inside it (with the opacity, which children must not inherit).
  const plan = planTransform(L.transform, ctx, window);
  const hint = sizeHint(L, ctx);
  const content: ContentBuilt =
    L.hidden || plan.opacity.neverVisible ? emptyBuilt(hint.w, hint.h) : buildContent(L, ctx);
  const tf = makeTransformFrame(L.name, plan, content.node ? content.bbox : hint, parent, o, ctx);
  emit(u.members, tf.inner, tf.o, ctx, {
    front: ctx.pos.get(L.id) ?? 0,
    run: () => {
      const node = content.node;
      if (!node) return;
      tf.inner.appendChild(node);
      node.name = L.name;
      node.x = tf.o.x + content.bbox.x;
      node.y = tf.o.y + content.bbox.y;
      applyOpacity(node, plan.opacity, ctx);
      applyBlend(node, L.blendMode);
    },
  }, [], new Set([...applied, L.id, ...u.ghosts.map((g) => g.id)]));
  return outer ?? tf.frame;
}

/**
 * Layers cut out by the same matte, stacked next to each other, go into one
 * frame: a copy of the matte layer sits at the bottom as the mask, and
 * everything above it only shows where the mask is.
 */
function buildMatted(matteId: string, members: Layer[], container: FrameNode, ctx: Ctx, w: number, h: number): void {
  const matte = ctx.byId.get(matteId);
  if (!matte) {
    emit(members, container, ZERO, ctx);
    return;
  }
  const frame = newFrame(`${matte.name} (matte)`, w, h, ctx);
  container.appendChild(frame);
  frame.x = 0;
  frame.y = 0;

  // The copy follows the matte layer's own parents, but is never anyone's parent itself.
  const copy: Layer = { ...matte, id: `${matte.id}#mask` };
  delete copy.shadow;
  delete copy.blendMode;
  const unit = planUnits([copy], ctx.pos, undefined, ctx.byId)[0]!;
  const mask = buildUnit(unit, frame, ZERO, ctx, true);
  if (!mask) {
    // A matte that never shows hides everything it cuts out.
    frame.remove();
    ctx.stats.nodes--;
    return;
  }
  mask.name = `${matte.name} (mask)`;
  try {
    (mask as SceneNode & { isMask: boolean }).isMask = true;
    const luma = members.some((m) => m.matte?.luma);
    (mask as SceneNode & { maskType: MaskType }).maskType = luma ? 'LUMINANCE' : 'ALPHA';
  } catch {
    warn(ctx, `"${matte.name}" could not be made a mask; the layers it cuts out arrive unmasked.`);
  }
  emit(members, frame, ZERO, ctx);
}

/** Builds every layer of a composition into `container`. Returns whether anything was keyframed. */
function buildLayers(comp: Comp, container: FrameNode, ctx: Ctx): boolean {
  const tracksBefore = ctx.motion.tracks;
  ctx.pos = new Map();
  ctx.byId = new Map();
  comp.layers.forEach((l, i) => {
    ctx.pos.set(l.id, i);
    ctx.byId.set(l.id, l);
  });

  const plain: Layer[] = [];
  const matted: Array<{ matteId: string; members: Layer[]; last: number }> = [];
  comp.layers.forEach((l, i) => {
    if (!l.matte || l.hidden || !ctx.byId.has(l.matte.layerId)) {
      plain.push(l);
      return;
    }
    const run = matted[matted.length - 1];
    if (run && run.matteId === l.matte.layerId && run.last === i - 1) {
      run.members.push(l);
      run.last = i;
    } else {
      matted.push({ matteId: l.matte.layerId, members: [l], last: i });
    }
  });
  const groups: Step[] = matted.map((m) => ({
    front: ctx.pos.get(m.members[0]!.id) ?? 0,
    run: () => buildMatted(m.matteId, m.members, container, ctx, comp.width, comp.height),
  }));
  emit(plain, container, ZERO, ctx, undefined, groups);
  return ctx.motion.tracks > tracksBefore;
}

// --------------------------------------------------------------------- root

const FRAME_GAP = 200;
/** Space between what was on the page and what is new. */
const BLOCK_GAP = 400;
/** Space between the frames and their components: far enough to read as an area of its own. */
const SIDE_GAP = 1200;
/** Space between the components inside a section, and around them. */
const ITEM_GAP = 160;
const SECTION_PAD = 160;

/** The part of the page that is already in use. Ask before building: the build adds to it. */
export function occupied(): Rect | null {
  const rects: Rect[] = [];
  for (const n of figma.currentPage.children) {
    if ('width' in n && 'x' in n) rects.push({ x: n.x, y: n.y, w: n.width, h: n.height });
  }
  return rects.length ? unionRects(rects) : null;
}

/**
 * Puts a node's top-left corner at a place on the page - measured on the
 * page, whatever the node sits in. (What "x" means for a node inside a
 * section is exactly what must not be taken for granted: measuring where the
 * node really ended up, and correcting, is right either way.)
 */
function moveTo(node: SceneNode, x: number, y: number): void {
  if (!('absoluteTransform' in node) || !('x' in node)) return;
  for (let pass = 0; pass < 3; pass++) {
    const at = node.absoluteTransform;
    const dx = x - at[0][2];
    const dy = y - at[1][2];
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    node.x += dx;
    node.y += dy;
  }
}

/**
 * Asks Figma itself whether an animated frame stays animated inside a
 * section, using a throw-away frame: it gets a keyframe on the page, moves
 * into a section, and has to take a second one there. Motion is new, and the
 * components are only worth tidying away if their animation survives it.
 */
function sectionsCarryMotion(): boolean {
  let frame: FrameNode | null = null;
  let section: SectionNode | null = null;
  try {
    frame = figma.createFrame();
    frame.resizeWithoutConstraints(10, 10);
    const dot = figma.createRectangle();
    frame.appendChild(dot);
    const probe = new MotionWriter(1);
    if (!probe.float(dot, 'OPACITY', [{ t: 0, v: 1 }, { t: 1, v: 0.5 }])) {
      // Nothing can be animated here at all, so a section cannot make it worse.
      return true;
    }
    const before = dot.timelines.length;
    section = figma.createSection();
    section.appendChild(frame);
    return dot.timelines.length === before && probe.float(dot, 'ROTATION', [{ t: 0, v: 0 }, { t: 1, v: 10 }]);
  } catch {
    return false;
  } finally {
    try {
      if (frame && !frame.removed) frame.remove();
      if (section && !section.removed) section.remove();
    } catch {
      // Left-overs of the probe are harmless.
    }
  }
}

/** Places nodes left to right, starting a new row when one gets too long. Positions are relative to (0, 0). */
function shelve(nodes: SceneNode[], gap: number): { spots: Array<{ node: SceneNode; x: number; y: number }>; w: number; h: number } {
  const area = nodes.reduce((sum, n) => sum + (n.width + gap) * (n.height + gap), 0);
  const widest = Math.max(...nodes.map((n) => n.width));
  // Aim for a landscape block, about twice as wide as it is tall.
  const limit = Math.max(widest, Math.sqrt(area * 2));
  const spots: Array<{ node: SceneNode; x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  for (const node of nodes) {
    if (x > 0 && x + node.width > limit) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    spots.push({ node, x, y });
    w = Math.max(w, x + node.width);
    rowH = Math.max(rowH, node.height);
    x += node.width + gap;
  }
  return { spots, w, h: y + rowH };
}

export interface Arranged {
  frames: FrameNode[];
  /** The sections holding the components, one per frame that has any. */
  sections: SceneNode[];
  warnings: string[];
}

/**
 * Lays out what one transfer built, clear of everything that was on the page
 * before (`taken`, from occupied()): the frames in a row, and well to the
 * right of them one section per frame with its components in tidy rows.
 */
export function arrange(builds: BuildOutput[], taken: Rect | null): Arranged {
  const frames = builds.map((b) => b.frame);
  const warnings: string[] = [];
  if (!frames.length) return { frames, sections: [], warnings };

  const rowW = frames.reduce((sum, f) => sum + f.width, 0) + FRAME_GAP * (frames.length - 1);
  const tallest = Math.max(...frames.map((f) => f.height));
  let x: number;
  let y: number;
  if (taken) {
    x = Math.round(taken.x);
    y = Math.round(taken.y + taken.h + BLOCK_GAP);
  } else {
    const centre = figma.viewport.center;
    x = Math.round(centre.x - rowW / 2);
    y = Math.round(centre.y - tallest / 2);
  }
  for (const f of frames) {
    moveTo(f, x, y);
    x += f.width + FRAME_GAP;
  }

  const sections = shelveSections(builds.map((b) => ({ name: b.frame.name, nodes: b.components })), x - FRAME_GAP + SIDE_GAP, y, warnings);
  return { frames, sections, warnings };
}

/**
 * Lays out groups of components from (left, top) downwards, each group in
 * tidy rows inside a section named after the frame it belongs to. Returns
 * the sections.
 */
function shelveSections(groups: Array<{ name: string; nodes: SceneNode[] }>, left: number, top: number, warnings: string[]): SceneNode[] {
  const withComponents = groups.map((g) => ({ name: g.name, nodes: g.nodes.filter((n) => !n.removed) })).filter((g) => g.nodes.length);
  const sections: SceneNode[] = [];
  if (!withComponents.length) return sections;

  const useSections = sectionsCarryMotion();
  if (!useSections) {
    warnings.push('Figma does not keep animation inside a section here, so the components were laid out on the page instead.');
  }
  const places: Array<{ node: SceneNode; x: number; y: number }> = [];
  for (const b of withComponents) {
    const nodes = b.nodes;
    const { spots, w, h } = shelve(nodes, ITEM_GAP);
    const mine = spots.map((spot) => ({ node: spot.node, x: left + SECTION_PAD + spot.x, y: top + SECTION_PAD + spot.y }));
    places.push(...mine);

    // Every component goes to its place on the page first. The section is then
    // made around them at its final size, so a component is already inside it
    // when it is handed over - at no moment does it lie outside its section.
    for (const p of mine) moveTo(p.node, p.x, p.y);
    if (useSections) {
      let section: SectionNode | null = null;
      try {
        section = figma.createSection();
        section.name = `${b.name} · Components`;
        tag(section, TAG_MADE, '1');
        section.resizeWithoutConstraints(w + SECTION_PAD * 2, h + SECTION_PAD * 2);
        moveTo(section, left, top);
        // Behind everything else, so that whatever does not go inside still shows on top of it.
        figma.currentPage.insertChild(0, section);
        let outside = 0;
        for (const p of mine) {
          try {
            section.appendChild(p.node);
          } catch {
            // Stays on the page, in the same place.
          }
          moveTo(p.node, p.x, p.y);
          if (p.node.parent !== section) outside++;
        }
        sections.push(section);
        if (outside) {
          warnings.push(
            `Figma kept ${outside} of the ${mine.length} components of "${b.name}" out of their section; they lie on top of it instead of inside it.`,
          );
        }
      } catch (err) {
        warnings.push(
          `The components of "${b.name}" could not be put into a section (${err instanceof Error ? err.message : String(err)}); they are on the page.`,
        );
        for (const p of mine) {
          if (p.node.parent !== figma.currentPage) figma.currentPage.appendChild(p.node);
        }
        try {
          if (section && !section.removed) section.remove();
        } catch {
          // An empty section left behind is harmless.
        }
      }
    }
    top += h + SECTION_PAD * 2 + FRAME_GAP;
  }
  // A last look, once nothing moves any more.
  for (const p of places) moveTo(p.node, p.x, p.y);
  return sections;
}

/**
 * Where the components an update built go: `home` is the section the design's
 * components were in before (null when there is none any more).
 */
export interface Rehoused {
  name: string;
  nodes: SceneNode[];
  home: SectionNode | null;
}

/**
 * Lays out the components of an update. New ones join the design's section,
 * which is tidied into rows again and resized (also when it only lost some);
 * a design without a section gets one below everything on the page.
 */
export function rehouse(groups: Rehoused[]): string[] {
  const warnings: string[] = [];
  const bySection = new Map<SectionNode, SceneNode[]>();
  const homeless: Array<{ name: string; nodes: SceneNode[] }> = [];
  let carries: boolean | null = null;
  for (const g of groups) {
    const nodes = g.nodes.filter((n) => !n.removed);
    if (g.home && !g.home.removed && (!nodes.length || (carries ??= sectionsCarryMotion()))) {
      bySection.set(g.home, [...(bySection.get(g.home) ?? []), ...nodes]);
    } else if (nodes.length) {
      homeless.push({ name: g.name, nodes });
    }
  }

  for (const [section, fresh] of bySection) {
    try {
      const isComponent = (n: SceneNode): boolean => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET';
      const there = section.children.filter(isComponent).sort((a, b) => a.y - b.y || a.x - b.x);
      const all = [...there, ...fresh.filter((n) => there.indexOf(n) === -1)];
      if (!all.length) {
        // Nothing is left of what it was made for.
        if (!section.children.length && madeHere(section)) section.remove();
        continue;
      }
      const { spots, w, h } = shelve(all, ITEM_GAP);
      // Whatever else was put into the section stays where it is, and inside.
      let wide = w + SECTION_PAD * 2;
      let tall = h + SECTION_PAD * 2;
      for (const other of section.children) {
        if (isComponent(other) || !('width' in other)) continue;
        wide = Math.max(wide, other.x + other.width + SECTION_PAD);
        tall = Math.max(tall, other.y + other.height + SECTION_PAD);
      }
      const at = section.absoluteTransform;
      const places = spots.map((spot) => ({ node: spot.node, x: at[0][2] + SECTION_PAD + spot.x, y: at[1][2] + SECTION_PAD + spot.y }));
      section.resizeWithoutConstraints(wide, tall);
      let outside = 0;
      for (const p of places) {
        moveTo(p.node, p.x, p.y);
        if (p.node.parent !== section) {
          try {
            section.appendChild(p.node);
          } catch {
            // Stays on the page, in the same place.
          }
          moveTo(p.node, p.x, p.y);
          if (p.node.parent !== section) outside++;
        }
      }
      for (const p of places) moveTo(p.node, p.x, p.y);
      if (outside) warnings.push(`Figma kept ${outside} new ${outside === 1 ? 'component' : 'components'} out of the section "${section.name}"; they lie on top of it instead of inside it.`);
    } catch (err) {
      warnings.push(`The section "${section.name}" could not be tidied (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  if (homeless.length) {
    const taken = occupied();
    const left = taken ? Math.round(taken.x) : 0;
    const top = taken ? Math.round(taken.y + taken.h + BLOCK_GAP) : 0;
    shelveSections(homeless, left, top, warnings);
  }
  return warnings;
}

/**
 * The images of a transfer as Figma knows them: by a hash of what they show.
 * Images Figma refuses are left out and reported.
 */
export function imageHashes(doc: BridgeDoc, images: Record<string, Uint8Array>, warnings: string[] = []): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const id of Object.keys(images)) {
    try {
      hashes.set(id, figma.createImage(images[id]!).hash);
    } catch (err) {
      warnings.push(`Image "${doc.assets[id]?.name ?? id}" was refused by Figma (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  return hashes;
}

/**
 * Says what a document would be built as, in a short text: the same for two
 * documents exactly when they show the same thing, with the same pose and the
 * same way of building. An update compares it to tell whether a design needs
 * anything done to it.
 */
export function designSignature(doc: BridgeDoc, hashes: Map<string, string>, components: boolean): string {
  const root = doc.comps[doc.rootCompId];
  const poster = root ? Math.max(0, Math.min(doc.posterTime, root.duration)) : 0;
  return hashText([BRIDGE_VERSION, new Signer(doc, hashes).comp(doc.rootCompId), Math.round(poster * 1000), components ? 'components' : 'flat'].join('|'));
}

/**
 * Builds one composition as a frame, with its components next to it. Where
 * things end up on the page is decided afterwards, by arrange().
 */
export function buildDocument(input: BuildInput): BuildOutput {
  const { doc } = input;
  const root = doc.comps[doc.rootCompId];
  if (!root) throw new Error('The transfer has no root composition.');

  const stats: Stats = { nodes: 0, warnings: [], created: [] };
  const motion = new MotionWriter(root.duration);

  const images = input.hashes ?? imageHashes(doc, input.images, stats.warnings);

  const into = input.into && !input.into.removed ? input.into : null;
  const frame = into ?? figma.createFrame();
  const replaced: SceneNode[] = into ? [...into.children] : [];
  stats.nodes++;
  if (!into) {
    stats.created.push(frame);
    frame.name = root.name;
    frame.resizeWithoutConstraints(size(root.width), size(root.height));
    frame.clipsContent = true;
    frame.fills = [solid(root.background)];
  }

  const stage = figma.createFrame();
  stage.name = 'Motion Bridge (building)';
  stage.fills = [];
  stage.clipsContent = false;
  frame.appendChild(stage);
  stats.created.push(stage);

  const library: Library = {
    enabled: !!input.components,
    shared: input.shared ?? newShared(),
    placed: [],
    own: new Set(),
    borrowed: new Set(),
  };
  const ctx: Ctx = {
    doc,
    images,
    fonts: input.fonts,
    tc: rootTime(root.duration, Math.max(0, Math.min(doc.posterTime, root.duration))),
    motion,
    stats,
    stage,
    depth: 0,
    pos: new Map(),
    byId: new Map(),
    library,
    signer: new Signer(doc, images),
  };
  try {
    buildLayers(root, frame, ctx);
  } catch (err) {
    for (let i = stats.created.length - 1; i >= 0; i--) {
      try {
        const node = stats.created[i]!;
        if (!node.removed) node.remove();
      } catch {
        // Already gone together with its parent.
      }
    }
    throw err;
  }
  stage.remove();
  if (into && (Math.abs(into.width - size(root.width)) > 0.01 || Math.abs(into.height - size(root.height)) > 0.01)) {
    // The composition has another size now. (Not before the build: a failed one leaves the frame as it was.)
    into.resizeWithoutConstraints(size(root.width), size(root.height));
  }

  // The timeline belongs to the top-level frame and is reached through any node inside it.
  // (With `into`, the first child is one of the old layers, which are about to go.)
  setTimelineLength((into ? frame.children[frame.children.length - 1] : frame.children[0]) ?? frame, root.duration, ctx);
  // What the frame uses directly comes first; what those are built from follows.
  const components = library.placed
    .map((p, order) => ({ ...p, order }))
    .filter((p) => !p.node.removed)
    .sort((p, q) => p.level - q.level || q.order - p.order)
    .map((p) => p.node);

  return { frame, replaced, components, reused: library.borrowed.size, nodes: stats.nodes, motion, warnings: stats.warnings };
}
