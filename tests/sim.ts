/**
 * Test support: a small stand-in for the Figma plugin API, a player that
 * evaluates the keyframe tracks written to it the way Figma's Motion
 * reference describes them, and a reference evaluator for the bridge format
 * (the After Effects transform model). Comparing the two shows whether the
 * builder's pivot frames, offsets and sign conventions are right.
 */
import type { AnimVec2, BridgeDoc, Comp, Ease, Key, Layer, Transform, Vec2 } from '../shared/format.ts';
import { evalAnim, evalAnimVec, evalKeys, numOps, vecOps } from '../shared/anim.ts';

// ------------------------------------------------------------------ matrices

/** x' = a x + c y + e,  y' = b x + d y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleMat = (x: number, y: number): Mat => [x, 0, 0, y, 0, 0];
/** Clockwise on screen (y down). */
export const rotateMat = (degrees: number): Mat => {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
};
/** m1 applied after m2. */
export const mul = (m1: Mat, m2: Mat): Mat => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
export const chain = (...ms: Mat[]): Mat => ms.reduce((acc, m) => mul(acc, m), IDENTITY);
export const apply = (m: Mat, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

// --------------------------------------------------------------- mock Figma

interface Frame {
  timelinePosition: number;
  value: { type: string; value: unknown };
  easing?: { type: string; easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number } };
}

let nextId = 1;

export class MockNode {
  type: string;
  readonly id = `${nextId++}:1`;
  name = '';
  parent: MockNode | null = null;
  children: MockNode[] = [];
  removed = false;
  relativeTransform: [[number, number, number], [number, number, number]] = [
    [1, 0, 0],
    [0, 1, 0],
  ];
  opacity = 1;
  blendMode = 'PASS_THROUGH';
  fills: unknown = [];
  strokes: unknown = [];
  strokeWeight = 1;
  strokeAlign = 'INSIDE';
  strokeCap = 'NONE';
  strokeJoin = 'MITER';
  strokeMiterLimit = 4;
  dashPattern: number[] = [];
  cornerRadius = 0;
  clipsContent = true;
  vectorPaths: Array<{ windingRule: string; data: string }> = [];
  fontName: unknown = null;
  characters = '';
  fontSize = 12;
  lineHeight: { value: number; unit: string } = { value: 14, unit: 'PIXELS' };
  letterSpacing: unknown = null;
  textAlignHorizontal = 'LEFT';
  textCase = 'ORIGINAL';
  textAutoResize = 'WIDTH_AND_HEIGHT';
  leadingTrim = 'NONE';
  isMask = false;
  maskType = 'ALPHA';
  effects: unknown[] = [];
  topLeftRadius = 0;
  topRightRadius = 0;
  bottomRightRadius = 0;
  bottomLeftRadius = 0;
  /** For an instance: the component it shows. */
  mainComponent: MockNode | null = null;
  visible = true;
  tracks = new Map<string, Frame[]>();
  private readonly pluginData = new Map<string, string>();
  private w = 100;
  private h = 100;
  private readonly world: MockFigma;

  constructor(type: string, world: MockFigma) {
    this.type = type;
    this.world = world;
  }

  get x(): number {
    return this.relativeTransform[0][2];
  }
  set x(v: number) {
    this.relativeTransform = [[...this.relativeTransform[0].slice(0, 2), v] as [number, number, number], this.relativeTransform[1]];
  }
  get y(): number {
    return this.relativeTransform[1][2];
  }
  set y(v: number) {
    this.relativeTransform = [this.relativeTransform[0], [...this.relativeTransform[1].slice(0, 2), v] as [number, number, number]];
  }

  get width(): number {
    if (this.type !== 'TEXT' || this.textAutoResize !== 'WIDTH_AND_HEIGHT') return this.w;
    const longest = Math.max(...this.characters.split('\n').map((l) => l.length));
    return longest * this.fontSize * 0.5;
  }
  get height(): number {
    if (this.type !== 'TEXT') return this.h;
    const lines = this.characters.split('\n').length;
    const first = this.leadingTrim === 'CAP_HEIGHT' ? this.fontSize * 0.7 : this.lineHeight.value;
    return first + (lines - 1) * this.lineHeight.value;
  }

  resize(w: number, h: number): void {
    if (!(w >= 0.01) || !(h >= 0.01)) throw new Error('resize: size must be at least 0.01');
    this.w = w;
    this.h = h;
  }
  resizeWithoutConstraints(w: number, h: number): void {
    this.resize(w, h);
  }
  /** Like Figma's scale tool: everything inside grows with the node. */
  rescale(s: number): void {
    this.w *= s;
    this.h *= s;
    this.fontSize *= s;
    this.lineHeight = { ...this.lineHeight, value: this.lineHeight.value * s };
    for (const child of this.children) {
      child.x *= s;
      child.y *= s;
      child.rescale(s);
    }
  }

  /**
   * The node's own space as seen from the page. A group has no space of its
   * own: what is inside it is placed in the space around the group, as in Figma.
   */
  get absoluteTransform(): [[number, number, number], [number, number, number]] {
    let m: Mat = IDENTITY;
    for (let n: MockNode | null = this; n && n.type !== 'PAGE'; n = n.parent) {
      if (n !== this && n.type === 'GROUP') continue;
      const [r0, r1] = n.relativeTransform;
      m = mul([r0[0], r1[0], r0[1], r1[1], r0[2], r1[2]], m);
    }
    return [
      [m[0], m[2], m[4]],
      [m[1], m[3], m[5]],
    ];
  }

  /** The upright box on the page that holds the node. */
  get absoluteBoundingBox(): { x: number; y: number; width: number; height: number } {
    const [r0, r1] = this.absoluteTransform;
    const m: Mat = [r0[0], r1[0], r0[1], r1[1], r0[2], r1[2]];
    const corners = [{ x: 0, y: 0 }, { x: this.width, y: 0 }, { x: this.width, y: this.height }, { x: 0, y: this.height }].map((c) => apply(m, c));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  /** What is drawn takes up the node's box here: no shadows, no strokes reaching out. */
  get absoluteRenderBounds(): { x: number; y: number; width: number; height: number } | null {
    return this.visible ? this.absoluteBoundingBox : null;
  }

  /** A vector's outline is its paths. */
  get fillGeometry(): Array<{ windingRule: string; data: string }> {
    return this.vectorPaths;
  }
  get strokeGeometry(): Array<{ windingRule: string; data: string }> {
    return this.vectorPaths;
  }

  /** A picture of the node: only the start of a PNG, which says how many pixels it has. */
  async exportAsync(settings: { format: string; constraint?: { type: string; value: number } }): Promise<Uint8Array> {
    if (this.world.exportFails) throw new Error('export failed');
    const scale = settings.constraint?.value ?? 1;
    const box = this.absoluteBoundingBox;
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, Math.round(box.width * scale));
    view.setUint32(20, Math.round(box.height * scale));
    // Two different nodes are two different pictures.
    bytes[32] = Number(this.id.split(':')[0]) % 256;
    this.world.exports.push(this.name);
    return bytes;
  }

  /**
   * What the node's timeline holds, the way Figma reports it when read:
   * translation and rotation add to the node at rest, scale multiplies it,
   * everything else replaces the resting value.
   */
  get animations(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, frames] of this.tracks) {
      const keyframeOperation = /^(TRANSLATION|ROTATION)/.test(key) ? 'OFFSET' : /^SCALE/.test(key) ? 'SCALE' : 'SET';
      const binding = {
        baseValue: frames[0]?.value,
        timelineDuration: this.world.timelineDuration,
        tracks: [{ id: key, keyframeOperation, keyframes: frames.map((f, i) => ({ id: `${key}-${i}`, easing: { type: 'LINEAR' }, ...f })) }],
      };
      const paint = /^(fills|strokes)\[(\d+)\]$/.exec(key);
      if (paint) {
        const list = (out[paint[1]!] ?? {}) as Record<number, unknown>;
        list[Number(paint[2])] = binding;
        out[paint[1]!] = list;
      } else out[key] = binding;
    }
    return out;
  }

  setPluginData(key: string, value: string): void {
    this.pluginData.set(key, value);
  }
  getPluginData(key: string): string {
    return this.pluginData.get(key) ?? '';
  }

  appendChild(child: MockNode): void {
    this.insertChild(this.children.length, child);
  }
  insertChild(index: number, child: MockNode): void {
    if (child.parent === this) {
      this.children = this.children.filter((c) => c !== child);
      this.children.splice(Math.min(index, this.children.length), 0, child);
      return;
    }
    if (this.type === 'SECTION') {
      // Real sections have rules of their own about what they take in; the tests can ask for either.
      if (this.world.sectionsRefuse.has(child.type)) return;
      if (this.world.sectionsNeedInside) {
        const [[, , ax], [, , ay]] = child.absoluteTransform;
        const [[, , sx], [, , sy]] = this.absoluteTransform;
        if (ax < sx || ay < sy || ax + child.width > sx + this.width || ay + child.height > sy + this.height) return;
      }
    }
    const [[, , beforeX], [, , beforeY]] = child.absoluteTransform;
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.splice(Math.min(index, this.children.length), 0, child);
    if (this.type === 'SECTION' && this.world.sectionsKeepPlace) {
      // One of the two things "moving into a section" can mean: the node stays where it is on the page.
      const [[, , nowX], [, , nowY]] = child.absoluteTransform;
      child.x += beforeX - nowX;
      child.y += beforeY - nowY;
    }
  }
  /** Every node below this one, of the given types (and, when asked, carrying the given plugin data). */
  findAllWithCriteria(criteria: { types: string[]; pluginData?: { keys?: string[] } }): MockNode[] {
    const keys = criteria.pluginData?.keys;
    const out: MockNode[] = [];
    const walk = (n: MockNode): void => {
      for (const c of n.children) {
        if (criteria.types.includes(c.type) && (!keys || keys.some((k) => c.getPluginData(k) !== ''))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  findAll(test: (node: MockNode) => boolean): MockNode[] {
    const out: MockNode[] = [];
    const walk = (n: MockNode): void => {
      for (const c of n.children) {
        if (test(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** Like Figma: what was inside goes with it. */
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    const gone = (n: MockNode): void => {
      n.removed = true;
      n.children.forEach(gone);
    };
    gone(this);
  }

  // Instances and their components.
  async getMainComponentAsync(): Promise<MockNode | null> {
    return this.mainComponent;
  }
  async getInstancesAsync(): Promise<MockNode[]> {
    return this.world.instances.filter((i) => i.mainComponent === this && !i.removed);
  }
  /** A variant is named "Property=Value, Other=Value"; that is all an instance's properties are here. */
  get componentProperties(): Record<string, { type: string; value: string }> {
    const main = this.mainComponent;
    const out: Record<string, { type: string; value: string }> = {};
    if (this.type !== 'INSTANCE' || !main || main.parent?.type !== 'COMPONENT_SET') return out;
    for (const part of main.name.split(', ')) {
      const at = part.indexOf('=');
      if (at > 0) out[part.slice(0, at)] = { type: 'VARIANT', value: part.slice(at + 1) };
    }
    return out;
  }
  /** Switches to the variant of the same set that has these values; throws when there is none, as Figma does. */
  setProperties(props: Record<string, string>): void {
    const now = this.componentProperties;
    for (const name of Object.keys(props)) {
      if (!(name in now)) throw new Error(`Could not find a component property with name: '${name}'`);
      now[name] = { type: 'VARIANT', value: props[name]! };
    }
    const wanted = Object.keys(now).map((name) => `${name}=${now[name]!.value}`).join(', ');
    const next = this.mainComponent!.parent!.children.find((c) => c.name === wanted);
    if (!next) throw new Error(`Unable to find a variant with those property values: ${wanted}`);
    this.mainComponent = next;
  }

  applyManualKeyframeTrack(field: { type: string; name?: string; collection?: string; index?: number }, track: { keyframes: Frame[] }): void {
    if (this.world.motionEnabled === false) throw new Error('"applyManualKeyframeTrack" is not a supported API');
    // Keyframes live on the timeline of a top-level frame: the node has to be inside one.
    const top = this.timelineRoot();
    if (!top || top === this) throw new Error('Only nodes inside a top-level frame can be animated');
    if (this.world.sectionsBreakMotion && top.parent?.type === 'SECTION') throw new Error('Frames inside a section cannot be animated');
    if (top.type === 'COMPONENT_SET' && this.parent === top) throw new Error('A variant itself cannot be animated');
    const key = field.type === 'PROPERTY' ? field.name! : `${field.collection}[${field.index}]`;
    if (this.world.rejectFields.has(key)) throw new Error(`${key} is not valid for this node`);
    for (let i = 1; i < track.keyframes.length; i++) {
      if (track.keyframes[i]!.timelinePosition < track.keyframes[i - 1]!.timelinePosition) throw new Error('keyframes out of order');
    }
    this.tracks.set(key, track.keyframes);
  }
  /** An instance shows its component's layers; it has none of its own. */
  createInstance(): MockNode {
    if (this.type !== 'COMPONENT') throw new Error('createInstance: not a component');
    const instance = new MockNode('INSTANCE', this.world);
    instance.mainComponent = this;
    instance.name = this.name;
    instance.resize(this.width, this.height);
    this.world.currentPage.appendChild(instance);
    this.world.instances.push(instance);
    return instance;
  }

  /** The frame whose timeline this node is on: the nearest one sitting on the page or in a section. */
  private timelineRoot(): MockNode | null {
    let top: MockNode | null = this;
    while (top && top.parent !== this.world.currentPage && top.parent?.type !== 'SECTION') top = top.parent;
    return top;
  }

  get timelines(): Array<{ id: string; duration: number }> {
    if (this.world.sectionsBreakMotion && this.timelineRoot()?.parent?.type === 'SECTION') return [];
    return [{ id: 'timeline', duration: this.world.timelineDuration }];
  }
  setTimelineDuration(_id: string, duration: number): void {
    this.world.timelineDuration = duration;
  }
}

export class MockFigma {
  motionEnabled = true;
  rejectComponents = false;
  /** Pretends that Figma loses a frame's animation once the frame sits in a section. */
  sectionsBreakMotion = false;
  /** Node types a section silently will not take in. */
  sectionsRefuse = new Set<string>();
  /** A section only takes in what already lies inside its bounds. */
  sectionsNeedInside = false;
  /** A node handed to a section keeps its place on the page instead of its x and y numbers. */
  sectionsKeepPlace = false;
  rejectFields = new Set<string>();
  timelineDuration = 1;
  /** Every instance ever made, so a component can say who shows it. */
  instances: MockNode[] = [];
  /** The names of the nodes a picture was asked of. */
  exports: string[] = [];
  exportFails = false;
  /** The pictures paints can point to, by hash. */
  pictures = new Map<string, { bytes: Uint8Array; width: number; height: number }>();
  root = { name: 'Mock file' };
  mixed = Symbol('mixed');
  currentPage: MockNode & { selection: MockNode[] };
  viewport = { center: { x: 0, y: 0 }, scrollAndZoomIntoView: (): void => undefined };

  constructor() {
    this.currentPage = Object.assign(new MockNode('PAGE', this), { selection: [] as MockNode[] });
  }
  private make(type: string): MockNode {
    const node = new MockNode(type, this);
    this.currentPage.appendChild(node);
    return node;
  }
  createFrame = (): MockNode => this.make('FRAME');
  createRectangle = (): MockNode => this.make('RECTANGLE');
  createEllipse = (): MockNode => this.make('ELLIPSE');
  createVector = (): MockNode => this.make('VECTOR');
  createText = (): MockNode => this.make('TEXT');
  createSection = (): MockNode => this.make('SECTION');
  createImage = (): { hash: string } => ({ hash: 'image-hash' });
  getImageByHash = (hash: string): { getBytesAsync(): Promise<Uint8Array>; getSizeAsync(): Promise<{ width: number; height: number }> } | null => {
    const picture = this.pictures.get(hash);
    if (!picture) return null;
    return { getBytesAsync: async () => picture.bytes, getSizeAsync: async () => ({ width: picture.width, height: picture.height }) };
  };
  /** A group around nodes that share a parent. Its children stay where they are: a group has no space of its own. */
  group = (nodes: MockNode[], parent: MockNode): MockNode => {
    const g = new MockNode('GROUP', this);
    const index = Math.min(...nodes.map((n) => parent.children.indexOf(n)).filter((i) => i >= 0));
    parent.insertChild(index < 0 || !isFinite(index) ? parent.children.length : index, g);
    const xs = nodes.flatMap((n) => [n.x, n.x + n.width]);
    const ys = nodes.flatMap((n) => [n.y, n.y + n.height]);
    for (const n of nodes) g.appendChild(n);
    g.x = Math.min(...xs);
    g.y = Math.min(...ys);
    g.resize(Math.max(0.01, Math.max(...xs) - Math.min(...xs)), Math.max(0.01, Math.max(...ys) - Math.min(...ys)));
    g.clipsContent = false;
    return g;
  };
  /** Like Figma: the frame itself becomes the component, keeping its children and their keyframes. */
  createComponentFromNode = (node: MockNode): MockNode => {
    if (this.rejectComponents) throw new Error('createComponentFromNode failed');
    if (node.type !== 'FRAME') throw new Error('createComponentFromNode: only frames');
    node.type = 'COMPONENT';
    return node;
  };
  combineAsVariants = (nodes: MockNode[], parent: MockNode): MockNode => {
    if (nodes.some((n) => n.type !== 'COMPONENT')) throw new Error('combineAsVariants: components only');
    const set = new MockNode('COMPONENT_SET', this);
    parent.appendChild(set);
    for (const n of nodes) set.appendChild(n);
    return set;
  };
  loadFontAsync = async (): Promise<void> => undefined;
  listAvailableFontsAsync = async (): Promise<unknown[]> => [];
  notify = (): void => undefined;
}

/** Installs a fresh mock as the global `figma` and returns it. */
export function installMockFigma(): MockFigma {
  const mock = new MockFigma();
  (globalThis as { figma?: unknown }).figma = mock;
  return mock;
}

// ------------------------------------------------- playing the tracks back

function toEase(e: Frame['easing']): Ease | undefined {
  if (!e || e.type === 'LINEAR') return undefined;
  if (e.type === 'HOLD') return { type: 'hold' };
  if (e.type === 'CUSTOM_CUBIC_BEZIER' && e.easingFunctionCubicBezier) return { type: 'bezier', ...e.easingFunctionCubicBezier };
  throw new Error(`Unexpected easing ${e.type}`);
}

function floatTrack(node: MockNode, name: string, t: number): number | undefined {
  const frames = node.tracks.get(name);
  if (!frames) return undefined;
  const keys: Key<number>[] = frames.map((f) => ({ t: f.timelinePosition, v: f.value.value as number, e: toEase(f.easing) }));
  return evalKeys(keys, t, numOps);
}

function vecTrack(node: MockNode, name: string, t: number): Vec2 | undefined {
  const frames = node.tracks.get(name);
  if (!frames) return undefined;
  const keys: Key<Vec2>[] = frames.map((f) => ({ t: f.timelinePosition, v: f.value.value as Vec2, e: toEase(f.easing) }));
  return evalKeys(keys, t, vecOps);
}

export function nodeSize(node: MockNode, t: number): Vec2 {
  return { x: floatTrack(node, 'WIDTH', t) ?? node.width, y: floatTrack(node, 'HEIGHT', t) ?? node.height };
}

/**
 * A node's matrix in its parent at time t, as Figma's Motion reference states
 * it: translation adds to the resting position, rotation (counter-clockwise
 * positive) and scale act around the node's centre.
 */
function localMatrix(node: MockNode, t: number): Mat {
  const [r0, r1] = node.relativeTransform;
  const rest: Mat = [r0[0], r1[0], r0[1], r1[1], r0[2], r1[2]];
  const xy = vecTrack(node, 'TRANSLATION_XY', t);
  const dx = (xy?.x ?? 0) + (floatTrack(node, 'TRANSLATION_X', t) ?? 0);
  const dy = (xy?.y ?? 0) + (floatTrack(node, 'TRANSLATION_Y', t) ?? 0);
  const s = vecTrack(node, 'SCALE_XY', t);
  const sx = (s?.x ?? 1) * (floatTrack(node, 'SCALE_X', t) ?? 1);
  const sy = (s?.y ?? 1) * (floatTrack(node, 'SCALE_Y', t) ?? 1);
  const turn = floatTrack(node, 'ROTATION', t) ?? 0;
  const dims = nodeSize(node, t);
  const c = { x: dims.x / 2, y: dims.y / 2 };
  return chain(translate(dx, dy), rest, translate(c.x, c.y), rotateMat(-turn), scaleMat(sx, sy), translate(-c.x, -c.y));
}

/** Matrix from a node's own space to the space of the top-level frame `root`. */
export function worldMatrix(node: MockNode, root: MockNode, t: number): Mat {
  let m = IDENTITY;
  for (let n: MockNode | null = node; n && n !== root; n = n.parent) m = mul(localMatrix(n, t), m);
  return m;
}

/** Opacity of a node at time t, including every frame around it. */
export function worldOpacity(node: MockNode, root: MockNode, t: number): number {
  let o = 1;
  for (let n: MockNode | null = node; n && n !== root; n = n.parent) o *= floatTrack(n, 'OPACITY', t) ?? n.opacity;
  return o;
}

export function findNode(root: MockNode, name: string, type?: string): MockNode | undefined {
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.name === name && (!type || n.type === type)) return n;
    stack.push(...n.children);
  }
  return undefined;
}

/** Names of every node under `root`, in painting order (back first). */
export function paintOrder(root: MockNode, types: string[]): string[] {
  const out: string[] = [];
  const walk = (n: MockNode): void => {
    for (const c of n.children) {
      if (types.includes(c.type)) out.push(c.name);
      walk(c);
    }
  };
  walk(root);
  return out;
}

// ----------------------------------------------- After Effects reference

export function transformMatrix(tr: Transform, t: number): Mat {
  const a = evalAnimVec(tr.anchor, t);
  const p = evalAnimVec(tr.position, t);
  const s = evalAnimVec(tr.scale, t);
  const r = evalAnim(tr.rotation, t, numOps);
  return chain(translate(p.x, p.y), rotateMat(r), scaleMat(s.x, s.y), translate(-a.x, -a.y));
}

/** A layer's matrix in its composition at composition time t, parents included. */
export function layerMatrix(comp: Comp, layer: Layer, t: number): Mat {
  let m = transformMatrix(layer.transform, t);
  let current = layer;
  for (let guard = 0; guard < 50 && current.parentId !== undefined; guard++) {
    const parent = comp.layers.find((l) => l.id === current.parentId);
    if (!parent) break;
    m = mul(transformMatrix(parent.transform, t), m);
    current = parent;
  }
  return m;
}

export function layerOpacity(layer: Layer, t: number): number {
  if (t < layer.inPoint - 1e-9 || t >= layer.outPoint - 1e-9) return 0;
  return evalAnim(layer.transform.opacity, t, numOps);
}

// ------------------------------------------------------- document helpers

export const vec = (x: number, y: number): AnimVec2 => ({ mode: 'vec', a: { v: { x, y } } });
export const vecKeys = (keys: Key<Vec2>[]): AnimVec2 => ({ mode: 'vec', a: { v: keys[0]!.v, k: keys } });

export function transform(over: Partial<Transform> = {}): Transform {
  return { anchor: vec(0, 0), position: vec(0, 0), scale: vec(1, 1), rotation: { v: 0 }, opacity: { v: 1 }, ...over };
}

export function solidLayer(id: string, name: string, w: number, h: number, tr: Partial<Transform>, extra: Partial<Layer> = {}): Layer {
  return {
    id,
    name,
    transform: transform(tr),
    content: { type: 'solid', width: w, height: h, color: { r: 1, g: 0, b: 0, a: 1 } },
    inPoint: 0,
    outPoint: 100,
    ...extra,
  };
}

export function docOf(comps: Comp[], posterTime = 0): BridgeDoc {
  const map: Record<string, Comp> = {};
  for (const c of comps) map[c.id] = c;
  return {
    format: 'motion-bridge',
    version: 1,
    source: { app: 'after-effects', version: 'test' },
    rootCompId: comps[0]!.id,
    posterTime,
    comps: map,
    assets: {},
    warnings: [],
  };
}

export function compOf(id: string, layers: Layer[], duration = 2, w = 800, h = 600): Comp {
  return { id, name: id, width: w, height: h, duration, frameRate: 30, background: { r: 0, g: 0, b: 0, a: 1 }, layers };
}
