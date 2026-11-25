/** Shape of the data returned by ae-panel/host/host.jsx. Keep the two in sync. */

export interface RawEase {
  /** Speed in value units per second. */
  s: number;
  /** Influence in percent. */
  i: number;
}

export interface RawKey {
  t: number;
  v: number | number[];
  /** In / out interpolation: linear, bezier, hold. */
  ii: 'l' | 'b' | 'h';
  oi: 'l' | 'b' | 'h';
  ie: RawEase[];
  oe: RawEase[];
  /** Spatial tangents, relative to the key's value. */
  it?: number[];
  ot?: number[];
  rv?: 1;
}

export interface RawProp {
  v: number | number[] | null;
  k?: RawKey[];
  /** Per-frame samples starting at time 0. */
  s?: { dt: number; v: Array<number | number[]> };
  sp?: 1;
  ex?: 1;
}

export interface RawShapePath {
  closed: 0 | 1;
  v: number[][];
  i: number[][];
  o: number[][];
  /** The path changes over time. */
  anim?: 1;
  /** Vertices per frame (x0, y0, x1, y1, ...), starting at time 0. Only for small paths. */
  s?: { dt: number; f: number[][] };
}

export interface RawShapeItem {
  mn: string;
  name: string;
  items?: RawShapeItem[];
  tr?: {
    a: RawProp | null;
    p: RawProp | null;
    s: RawProp | null;
    r: RawProp | null;
    o: RawProp | null;
    sk: RawProp | null;
  };
  size?: RawProp | null;
  pos?: RawProp | null;
  round?: RawProp | null;
  starType?: RawProp | null;
  points?: RawProp | null;
  rot?: RawProp | null;
  inner?: RawProp | null;
  outer?: RawProp | null;
  innerRound?: RawProp | null;
  outerRound?: RawProp | null;
  path?: RawShapePath | null;
  color?: RawProp | null;
  opacity?: RawProp | null;
  rule?: RawProp | null;
  width?: RawProp | null;
  cap?: RawProp | null;
  join?: RawProp | null;
  miter?: RawProp | null;
  dashes?: Array<{ mn: string; v: number }> | null;
  start?: RawProp | null;
  end?: RawProp | null;
  offset?: RawProp | null;
  trimType?: RawProp | null;
  radius?: RawProp | null;
  /** Merge Paths: 1 merge, 2 add, 3 subtract, 4 intersect, 5 exclude intersections. */
  mode?: RawProp | null;
}

export interface RawText {
  text: string;
  font: string;
  family: string;
  style: string;
  size: number;
  fill?: number[] | null;
  stroke?: number[] | null;
  strokeWidth?: number;
  justify: 'left' | 'center' | 'right' | 'justify';
  tracking: number;
  leading?: number;
  box?: 1;
  boxSize?: number[] | null;
  boxPos?: number[] | null;
  /** Four numbers per line: start x, start y, end x, end y. */
  baselines?: number[] | null;
  allCaps?: 1;
  smallCaps?: 1;
  textKeys?: number;
  animators?: number;
  rect?: number[];
}

export interface RawEffect {
  name: string;
  mn: string;
  /** Only for effects that are carried over (Drop Shadow). */
  p?: Record<string, RawProp | null>;
  /** Drop Shadow: the value that means 100 % opacity. */
  omax?: number;
}

export type RawLayerType = 'null' | 'solid' | 'footage' | 'precomp' | 'shape' | 'text' | 'camera' | 'light' | 'other';

export interface RawLayer {
  index: number;
  name: string;
  enabled: 0 | 1;
  inPoint: number;
  outPoint: number;
  startTime: number;
  stretch: number;
  parent: number | null;
  type: RawLayerType;
  src?: string;
  w?: number;
  h?: number;
  noVideo?: 1;
  guide?: 1;
  adjustment?: 1;
  threeD?: 1;
  timeRemap?: 1;
  collapse?: 1;
  isMatte?: 1;
  /** Track matte: index of the matte layer and its kind (alpha, alpha inverted, luma, luma inverted). */
  matte?: { i: number; t: 'a' | 'ai' | 'l' | 'li' };
  blend?: string;
  /** Effects that change the picture (expression controls are left out). */
  fx?: RawEffect[];
  masks?: number;
  /** Never visible (switched off, a guide, or at zero opacity throughout): only the transform was read. */
  skip?: 1;
  /** Time remapping of a nested composition: its time as a function of this composition's time. */
  remap?: RawProp | null;
  tr?: {
    a: RawProp | null;
    p?: RawProp | null;
    px?: RawProp | null;
    py?: RawProp | null;
    s: RawProp | null;
    r: RawProp | null;
    o: RawProp | null;
  };
  shape?: RawShapeItem[];
  text?: RawText;
}

/** One control a nested composition exposes (an Essential Property) and the value a layer gives it. */
export interface RawControlValue {
  name: string;
  v?: number | number[];
  text?: string;
  /** A menu, checkbox or popup rather than a free number. */
  menu?: 1;
}

export interface RawComp {
  /** Unique per composition and set of control values: the comp id, plus ~n when controls apply. */
  id: string;
  /** The After Effects composition this was read from. */
  cid?: string;
  /** The control values this version was read with. */
  ep?: RawControlValue[];
  name: string;
  w: number;
  h: number;
  duration: number;
  frameRate: number;
  bg: number[] | null;
  layers: RawLayer[];
}

export interface RawFootage {
  id: string;
  name: string;
  w: number;
  h: number;
  solid?: number[] | null;
  still?: 0 | 1;
  file?: string | null;
  missing?: 1;
  placeholder?: 1;
}

export interface RawDump {
  host: string;
  ae: string;
  project: string | null;
  rootId: string;
  poster: number;
  comps: Record<string, RawComp>;
  footage: Record<string, RawFootage>;
  warnings: Array<{ comp?: string; layer?: string; message: string }>;
  /** Template options of the root composition that were read in every setting. */
  controllers?: RawController[];
  /** The setting of each option in the composition as it is (same order as controllers). */
  base?: number[];
  /** Settings still to fetch with exportState (host answer only). */
  pending?: number[][];
  /** The root composition in the other settings. */
  states?: RawState[];
}

export interface RawController {
  id: string;
  name: string;
  layer: string;
  prop?: string;
  kind?: 'menu' | 'checkbox';
  min: number;
  max: number;
  value: number;
}

/** The root composition with other option settings. A null layer is unchanged from the first read. */
export interface RawState {
  index: number;
  values: number[];
  layers: Array<RawLayer | null>;
  comps?: Record<string, RawComp>;
  footage?: Record<string, RawFootage>;
  warnings?: Array<{ comp?: string; layer?: string; message: string }>;
}

export type HostResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string; line?: number };
