/**
 * Motion Bridge transfer format.
 *
 * One document describes a composition tree with its motion. Both directions
 * (After Effects -> Figma and Figma -> After Effects) speak this format, so
 * neither side needs to know anything about the other application.
 *
 * Conventions
 *  - Time is in seconds, relative to the start of the composition that owns
 *    the value.
 *  - Coordinates are pixels, y pointing down.
 *  - A transform means  M = T(position) . R(rotation) . S(scale) . T(-anchor)
 *    (the After Effects model). `position` lives in the parent's space,
 *    `anchor` in the element's own space.
 *  - Rotation is in degrees, clockwise positive.
 *  - Scale is a multiplier (1 = 100 %), opacity and colours are 0..1.
 *  - Lists of layers / children are ordered front-most first.
 *  - The `ease` on a key describes how the value travels from the previous
 *    key to this one.
 */

export const FORMAT_NAME = 'motion-bridge';
export const FORMAT_VERSION = 3;

export interface Vec2 {
  x: number;
  y: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Ease =
  | { type: 'linear' }
  | { type: 'hold' }
  | { type: 'bezier'; x1: number; y1: number; x2: number; y2: number }
  /** Only produced by Figma. `bounce` is Figma's normalised 0..1 value. */
  | { type: 'spring'; bounce: number };

export interface Key<T> {
  /** Time in seconds. */
  t: number;
  v: T;
  /** How the value arrives at this key from the previous one. Linear when omitted. */
  e?: Ease;
}

/** A value that may change over time. `v` is used when there are no keys. */
export interface Anim<T> {
  v: T;
  k?: Key<T>[];
}

/**
 * A two-dimensional animated value. `vec` keeps both axes on one set of keys
 * (one ease per key); `split` animates each axis on its own.
 */
export type AnimVec2 =
  | { mode: 'vec'; a: Anim<Vec2> }
  | { mode: 'split'; x: Anim<number>; y: Anim<number> };

export interface Transform {
  anchor: AnimVec2;
  position: AnimVec2;
  scale: AnimVec2;
  rotation: Anim<number>;
  opacity: Anim<number>;
}

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** One closed or open bezier outline. Tangents are relative to their vertex. */
export interface SubPath {
  closed: boolean;
  v: Vec2[];
  i: Vec2[];
  o: Vec2[];
}

export interface Paint {
  /** Alpha carries the paint's opacity. */
  color: Anim<RGBA>;
}

export interface ShapeStyle {
  /** Front-most first. */
  fills: Paint[];
  /** Front-most first. */
  strokes: Paint[];
  strokeWidth?: Anim<number>;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  miterLimit?: number;
  dashes?: number[];
  fillRule?: 'nonzero' | 'evenodd';
  /** Trim values are fractions 0..1 of the outline. */
  trim?: { start: Anim<number>; end: Anim<number>; offset: Anim<number> };
  /** Rounding applied to every corner of the outline. */
  cornerRadius?: Anim<number>;
}

/** Children share this element's local space. */
export interface GroupContent {
  type: 'group';
  children: Element[];
}

/** Rectangle centred on the local origin. */
export interface RectContent {
  type: 'rect';
  size: AnimVec2;
  radius: Anim<number>;
  /** One radius per corner (top-left, top-right, bottom-right, bottom-left). Used instead of `radius` when present. */
  radii?: [Anim<number>, Anim<number>, Anim<number>, Anim<number>];
  style: ShapeStyle;
}

/** Ellipse centred on the local origin. */
export interface EllipseContent {
  type: 'ellipse';
  size: AnimVec2;
  style: ShapeStyle;
}

/** Static outlines in local space. Several sub-paths form one compound shape. */
export interface PathContent {
  type: 'path';
  paths: SubPath[];
  style: ShapeStyle;
}

/** Flat colour covering (0,0)-(width,height). */
export interface SolidContent {
  type: 'solid';
  width: number;
  height: number;
  color: RGBA;
}

/**
 * Bitmap covering (0,0)-(width,height). The asset may hold more pixels than
 * that (an image exported at twice its size); it is fitted to the rectangle.
 */
export interface ImageContent {
  type: 'image';
  width: number;
  height: number;
  assetId: string;
}

export interface TextContent {
  type: 'text';
  text: string;
  fontFamily: string;
  fontStyle: string;
  postScriptName?: string;
  fontSize: number;
  fill?: RGBA;
  stroke?: { color: RGBA; width: number };
  align: 'left' | 'center' | 'right' | 'justify';
  /** Thousandths of an em. */
  tracking: number;
  /** Distance between baselines in pixels. */
  lineHeight: number;
  /**
   * Where the first line's baseline is pinned, in local space: its left end
   * for left-aligned text, its middle for centred, its right end for
   * right-aligned text.
   */
  firstBaseline: Vec2;
  /** Present for paragraph text: the box in local space. */
  box?: Rect;
  caps?: 'all' | 'small';
  /**
   * Where the glyphs are drawn, in local space, when the sending application
   * can measure that (Figma can). The receiving side then lines the text up
   * with this instead of trusting `firstBaseline`, which Figma can only
   * estimate: it does not hand out font metrics.
   */
  ink?: Rect;
}

/** A nested composition covering (0,0)-(width,height), clipped to it. */
export interface CompContent {
  type: 'comp';
  compId: string;
  width: number;
  height: number;
  /** Time in the owning composition at which the nested one starts playing. */
  startTime: number;
  /**
   * Time remapping: the nested composition's time as a function of the owning
   * composition's time. Used instead of `startTime` when present.
   */
  remap?: Anim<number>;
  /** The set of interchangeable versions this composition is one of (see BridgeDoc.sets). */
  setId?: string;
  /** Which version of the set this layer shows, when versions cannot be told apart by composition (see CompSet). */
  variant?: number;
}

/** No visible content (a null object). The size is only a visual hint. */
export interface EmptyContent {
  type: 'empty';
  width: number;
  height: number;
}

export type Content =
  | GroupContent
  | RectContent
  | EllipseContent
  | PathContent
  | SolidContent
  | ImageContent
  | TextContent
  | CompContent
  | EmptyContent;

export interface DropShadow {
  /** Alpha carries the shadow's opacity. */
  color: RGBA;
  offset: Vec2;
  blur: number;
}

export interface Element {
  name: string;
  transform: Transform;
  content: Content;
  blendMode?: BlendMode;
  shadow?: DropShadow;
}

export interface Layer extends Element {
  id: string;
  /** Another layer of the same composition whose transform this one follows. */
  parentId?: string;
  /** The layer is only visible between these two times. */
  inPoint: number;
  outPoint: number;
  /** Not drawn itself; kept because other layers follow its transform or use it as their matte. */
  hidden?: boolean;
  /** Only shown where another layer of the same composition is opaque (a track matte). */
  matte?: { layerId: string; inverted?: boolean; luma?: boolean };
}

export interface Comp {
  id: string;
  name: string;
  width: number;
  height: number;
  /**
   * Seconds, and frames per second. Both are 0 when the source has no timing
   * of its own (a Figma frame without animation has no length, and no Figma
   * frame has a frame rate): After Effects then uses its own settings.
   */
  duration: number;
  frameRate: number;
  background: RGBA;
  /** Front-most first. */
  layers: Layer[];
}

export interface Asset {
  id: string;
  name: string;
  width: number;
  height: number;
  mime?: string;
  /** Base64 bytes. Only present in file exports; the live bridge serves bytes separately. */
  data?: string;
}

export interface Warning {
  level: 'info' | 'warn';
  message: string;
  comp?: string;
  layer?: string;
}

/**
 * Compositions that are versions of one another: the same template with
 * other option settings (another market, another logo ...). In Figma this
 * becomes one component set, with one variant property per option.
 */
export interface CompSet {
  id: string;
  name: string;
  /** The options, each with the names of its settings. */
  props: Array<{ name: string; values: string[] }>;
  /**
   * One entry per version: the setting it shows for each option (index into
   * `values`). With `at`, the version is the composition frozen at that
   * moment of its own time - a picker, where every frame holds another
   * picture and a control decides which one shows.
   */
  variants: Array<{ compId: string; choice: number[]; at?: number }>;
}

/**
 * Where a document was read from, so that a design built from it can be
 * brought up to date later: the composition is read again the same way.
 */
export interface DocLink {
  /** The composition's id in its After Effects project. */
  compId: string;
  /** The template options that were read in every setting, each as "layer/name". */
  options: string[];
}

export interface BridgeDoc {
  format: typeof FORMAT_NAME;
  version: number;
  source: { app: 'after-effects' | 'figma'; version: string; project?: string };
  rootCompId: string;
  /** Time (in the root composition) whose look becomes the static design. */
  posterTime: number;
  comps: Record<string, Comp>;
  sets?: Record<string, CompSet>;
  assets: Record<string, Asset>;
  warnings: Warning[];
  link?: DocLink;
  /**
   * Present when the document is an update: the designs (by their key, see
   * DesignLink in protocol.ts) it was read for. They are rebuilt in place
   * instead of a new frame being made.
   */
  update?: string[];
}

export function isBridgeDoc(value: unknown): value is BridgeDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<BridgeDoc>;
  return (
    doc.format === FORMAT_NAME &&
    typeof doc.version === 'number' &&
    typeof doc.rootCompId === 'string' &&
    !!doc.comps &&
    typeof doc.comps === 'object' &&
    !!doc.comps[doc.rootCompId]
  );
}

/**
 * Several compositions sent in one go. Each is a document of its own; images
 * with the same id are the same image and travel once.
 */
export const BUNDLE_NAME = 'motion-bridge-bundle';

export interface BridgeBundle {
  format: typeof BUNDLE_NAME;
  version: number;
  docs: BridgeDoc[];
}

/** One composition travels as a plain document, several as a bundle. */
export function packDocs(docs: BridgeDoc[]): BridgeDoc | BridgeBundle {
  if (docs.length === 1) return docs[0]!;
  return { format: BUNDLE_NAME, version: FORMAT_VERSION, docs };
}

/** The documents in a transfer or file, whichever of the two shapes it has. Null when it is neither. */
export function unpackDocs(value: unknown): BridgeDoc[] | null {
  if (isBridgeDoc(value)) return [value];
  if (!value || typeof value !== 'object') return null;
  const bundle = value as Partial<BridgeBundle>;
  if (bundle.format !== BUNDLE_NAME || !Array.isArray(bundle.docs) || !bundle.docs.length) return null;
  return bundle.docs.every(isBridgeDoc) ? bundle.docs : null;
}

export const rootName = (doc: BridgeDoc): string => doc.comps[doc.rootCompId]?.name ?? 'Composition';
