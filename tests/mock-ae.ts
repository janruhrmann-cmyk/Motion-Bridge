/**
 * Test support: just enough of After Effects' scripting objects to run
 * host.jsx outside After Effects. It checks the script's logic and its
 * output format - not After Effects' real behaviour.
 */

export const PVT = {
  OneD: 'OneD',
  TwoD: 'TwoD',
  ThreeD: 'ThreeD',
  TwoD_SPATIAL: 'TwoD_SPATIAL',
  ThreeD_SPATIAL: 'ThreeD_SPATIAL',
  COLOR: 'COLOR',
  SHAPE: 'SHAPE',
  TEXT_DOCUMENT: 'TEXT_DOCUMENT',
  NO_VALUE: 'NO_VALUE',
} as const;

export const KIT = { LINEAR: 'LINEAR', BEZIER: 'BEZIER', HOLD: 'HOLD' } as const;

export interface MockEase {
  speed: number;
  influence: number;
}

export interface MockKey {
  time: number;
  value: unknown;
  inType?: string;
  outType?: string;
  inEase?: MockEase[];
  outEase?: MockEase[];
  inTan?: number[];
  outTan?: number[];
  roving?: boolean;
}

const EASY: MockEase = { speed: 0, influence: 33.33333 };

/** What After Effects' undo list would hold: one entry per undo group, with the values to go back to. */
export const undo = {
  open: null as Array<{ prop: Prop; before: unknown }> | null,
  stack: [] as Array<Array<{ prop: Prop; before: unknown }>>,
  /** Every value ever set by a script, for tests that want to know nothing was left changed. */
  sets: 0,
};

export class Prop {
  matchName: string;
  name: string;
  propertyValueType: string;
  value: unknown;
  keys: MockKey[];
  enabled = true;
  canSetExpression = true;
  expressionEnabled = false;
  expression = '';
  propertyType = 'PROPERTY';
  /** Stands in for evaluating `expression`. */
  expressionFn: ((t: number) => unknown) | null = null;
  hasMin = false;
  hasMax = false;
  minValue = 0;
  maxValue = 0;
  isDropdownEffect = false;
  /** For an Essential Property on a layer: the property inside the nested composition. */
  essentialPropertySource: Prop | null = null;
  parentProperty: { name: string } | null = null;

  constructor(matchName: string, type: string, value: unknown, keys: MockKey[] = []) {
    this.matchName = matchName;
    this.name = matchName;
    this.propertyValueType = type;
    this.value = value;
    this.keys = keys;
  }
  get numKeys(): number {
    return this.keys.length;
  }
  private key(i: number): MockKey {
    return this.keys[i - 1]!;
  }
  keyTime(i: number): number {
    return this.key(i).time;
  }
  keyValue(i: number): unknown {
    return this.key(i).value;
  }
  keyInInterpolationType(i: number): string {
    return this.key(i).inType ?? KIT.BEZIER;
  }
  keyOutInterpolationType(i: number): string {
    return this.key(i).outType ?? KIT.BEZIER;
  }
  keyInTemporalEase(i: number): MockEase[] {
    return this.key(i).inEase ?? [EASY];
  }
  keyOutTemporalEase(i: number): MockEase[] {
    return this.key(i).outEase ?? [EASY];
  }
  keyInSpatialTangent(i: number): number[] {
    return this.key(i).inTan ?? [0, 0, 0];
  }
  keyOutSpatialTangent(i: number): number[] {
    return this.key(i).outTan ?? [0, 0, 0];
  }
  keyRoving(i: number): boolean {
    return !!this.key(i).roving;
  }
  /** A menu or checkbox: a whole number between min and max. */
  range(min: number, max: number, dropdown = true): this {
    this.hasMin = true;
    this.hasMax = true;
    this.minValue = min;
    this.maxValue = max;
    this.isDropdownEffect = dropdown;
    return this;
  }
  /** Gives the property an expression: its text (which host.jsx searches) and what it evaluates to. */
  expr(text: string, fn: (t: number) => unknown): this {
    this.expression = text;
    this.expressionEnabled = true;
    this.expressionFn = fn;
    return this;
  }
  setValue(v: unknown): void {
    undo.sets++;
    if (undo.open) undo.open.push({ prop: this, before: this.value });
    this.value = v;
  }
  /** Straight-line interpolation: enough to tell "moves" from "does not move". */
  valueAtTime(t: number, preExpression = false): unknown {
    if (this.expressionEnabled && this.expressionFn && !preExpression) return this.expressionFn(t);
    if (!this.keys.length) return this.value;
    const first = this.keys[0]!;
    const last = this.keys[this.keys.length - 1]!;
    if (t <= first.time) return first.value;
    if (t >= last.time) return last.value;
    for (let i = 1; i < this.keys.length; i++) {
      const a = this.keys[i - 1]!;
      const b = this.keys[i]!;
      if (t > b.time) continue;
      const p = (t - a.time) / (b.time - a.time);
      if (typeof a.value === 'number') return a.value + ((b.value as number) - a.value) * p;
      if (Array.isArray(a.value)) return a.value.map((v: number, d: number) => v + ((b.value as number[])[d]! - v) * p);
      return a.value;
    }
    return last.value;
  }
}

export class Group {
  matchName: string;
  name: string;
  items: Array<Prop | Group>;
  enabled = true;
  propertyType = 'GROUP';

  constructor(matchName: string, items: Array<Prop | Group> = [], name?: string) {
    this.matchName = matchName;
    this.name = name ?? matchName;
    this.items = items;
  }
  get numProperties(): number {
    return this.items.length;
  }
  property(key: string | number): Prop | Group | null {
    if (typeof key === 'number') return this.items[key - 1] ?? null;
    return this.items.find((p) => p.matchName === key || p.name === key) ?? null;
  }
}

export class SolidSource {
  color: number[];
  constructor(color: number[]) {
    this.color = color;
  }
}
export class FileSource {
  isStill: boolean;
  file: { fsName: string } | null;
  constructor(path: string | null, isStill: boolean) {
    this.file = path ? { fsName: path } : null;
    this.isStill = isStill;
  }
}
export class FootageItem {
  id: number;
  name: string;
  width: number;
  height: number;
  mainSource: SolidSource | FileSource;
  footageMissing = false;
  constructor(id: number, name: string, width: number, height: number, mainSource: SolidSource | FileSource) {
    this.id = id;
    this.name = name;
    this.width = width;
    this.height = height;
    this.mainSource = mainSource;
  }
}

export interface MockLayer {
  [key: string]: unknown;
  index: number;
  name: string;
  matchName: string;
  parent: MockLayer | null;
  property(name: string): Group | null;
}

export class CompItem {
  id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  frameDuration: number;
  bgColor = [0.1, 0.1, 0.1];
  time = 0;
  layers: MockLayer[] = [];
  /** The compositions this one is a layer in. */
  usedIn: CompItem[] = [];
  parentFolder: { name: string } | null = null;
  constructor(id: number, name: string, width: number, height: number, duration: number, frameRate = 30) {
    this.id = id;
    this.name = name;
    this.width = width;
    this.height = height;
    this.duration = duration;
    this.frameRate = frameRate;
    this.frameDuration = 1 / frameRate;
  }
  get numLayers(): number {
    return this.layers.length;
  }
  layer(i: number): MockLayer {
    return this.layers[i - 1]!;
  }
}

export interface TransformSpec {
  anchor?: Prop;
  position?: Prop;
  scale?: Prop;
  rotation?: Prop;
  opacity?: Prop;
}

export function transformGroup(spec: TransformSpec): Group {
  const position = spec.position ?? new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [0, 0, 0]);
  (position as unknown as { dimensionsSeparated: boolean }).dimensionsSeparated = false;
  return new Group('ADBE Transform Group', [
    spec.anchor ?? new Prop('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [0, 0, 0]),
    position,
    spec.scale ?? new Prop('ADBE Scale', PVT.ThreeD, [100, 100, 100]),
    spec.rotation ?? new Prop('ADBE Rotate Z', PVT.OneD, 0),
    spec.opacity ?? new Prop('ADBE Opacity', PVT.OneD, 100),
  ]);
}

export function makeLayer(
  comp: CompItem,
  name: string,
  matchName: string,
  groups: Group[],
  extra: Record<string, unknown> = {},
): MockLayer {
  const layer: MockLayer = {
    index: comp.layers.length + 1,
    name,
    matchName,
    enabled: true,
    inPoint: 0,
    outPoint: comp.duration,
    startTime: 0,
    stretch: 100,
    parent: null,
    nullLayer: false,
    hasVideo: true,
    guideLayer: false,
    adjustmentLayer: false,
    threeDLayer: false,
    timeRemapEnabled: false,
    collapseTransformation: false,
    isTrackMatte: false,
    hasTrackMatte: false,
    trackMatteLayer: null,
    trackMatteType: 'NO_TRACK_MATTE',
    blendingMode: 'NORMAL',
    width: comp.width,
    height: comp.height,
    numProperties: groups.length,
    property(key: string | number): Group | null {
      if (typeof key === 'number') return groups[key - 1] ?? null;
      return groups.find((g) => g.matchName === key) ?? null;
    },
    sourceRectAtTime(): { left: number; top: number; width: number; height: number } {
      return { left: 0, top: -30, width: 120, height: 40 };
    },
    ...extra,
  };
  comp.layers.push(layer);
  return layer;
}

/** Puts the global objects host.jsx expects in place. */
export function installAeGlobals(activeItem: CompItem | null, itemsById: Map<number, unknown> = new Map(), items: unknown[] = activeItem ? [activeItem] : []): void {
  const blend: Record<string, string> = {};
  for (const name of [
    'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'CLASSIC_COLOR_BURN', 'LINEAR_BURN', 'ADD', 'LINEAR_DODGE', 'LIGHTEN',
    'SCREEN', 'COLOR_DODGE', 'CLASSIC_COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE',
    'CLASSIC_DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
  ]) {
    blend[name] = name;
  }
  undo.open = null;
  undo.stack = [];
  undo.sets = 0;
  Object.assign(globalThis, {
    app: {
      version: '99.0 (mock)',
      project: {
        activeItem,
        file: { name: 'mock.aep' },
        rootFolder: { name: 'Root' },
        numItems: items.length,
        item: (i: number) => items[i - 1] ?? null,
        itemByID: (id: number) =>
          activeItem && id === activeItem.id
            ? activeItem
            : (itemsById.get(id) ?? items.find((it) => it instanceof CompItem && it.id === id) ?? null),
      },
      beginUndoGroup: (): void => {
        undo.open = [];
      },
      endUndoGroup: (): void => {
        if (undo.open) undo.stack.push(undo.open);
        undo.open = null;
      },
      /** 16 is Edit > Undo. */
      executeCommand: (id: number): void => {
        if (id !== 16) return;
        const entry = undo.stack.pop();
        if (!entry) throw new Error('nothing to undo');
        for (let i = entry.length - 1; i >= 0; i--) entry[i]!.prop.value = entry[i]!.before;
      },
    },
    PropertyType: { PROPERTY: 'PROPERTY', INDEXED_GROUP: 'GROUP', NAMED_GROUP: 'GROUP' },
    CompItem,
    FootageItem,
    SolidSource,
    FileSource,
    PropertyValueType: PVT,
    KeyframeInterpolationType: KIT,
    BlendingMode: blend,
    TrackMatteType: {
      NO_TRACK_MATTE: 'NO_TRACK_MATTE',
      ALPHA: 'ALPHA',
      ALPHA_INVERTED: 'ALPHA_INVERTED',
      LUMA: 'LUMA',
      LUMA_INVERTED: 'LUMA_INVERTED',
    },
    ParagraphJustification: {
      LEFT_JUSTIFY: 'LEFT_JUSTIFY',
      RIGHT_JUSTIFY: 'RIGHT_JUSTIFY',
      CENTER_JUSTIFY: 'CENTER_JUSTIFY',
      FULL_JUSTIFY_LASTLINE_LEFT: 'FULL_JUSTIFY_LASTLINE_LEFT',
    },
  });
}

// ---------------------------------------------------------------- building
//
// The other half of the stand-in: enough of After Effects' *writing* API to
// run the part of host.jsx that builds compositions from a plan. What it
// builds is made of the same objects as above, so the reading half of
// host.jsx can read it back.

export class KeyframeEase {
  speed: number;
  influence: number;
  constructor(speed: number, influence: number) {
    if (!(influence >= 0.1 && influence <= 100)) throw new Error(`KeyframeEase: influence ${influence} is out of range`);
    this.speed = speed;
    this.influence = influence;
  }
}

export class Shape {
  vertices: number[][] = [];
  inTangents: number[][] = [];
  outTangents: number[][] = [];
  closed = true;
}

/** How many eases a key of this kind of value carries per side. */
function easeCount(type: string): number {
  if (type === PVT.TwoD) return 2;
  if (type === PVT.ThreeD) return 3;
  return 1;
}

/** The writing side of a property. Kept apart from Prop so the reading tests stay as they are. */
export function writable(prop: Prop): Prop {
  const p = prop as Prop & Record<string, unknown>;
  const find = (t: number): number => {
    let best = 0;
    for (let i = 1; i < prop.keys.length; i++) {
      if (Math.abs(prop.keys[i]!.time - t) < Math.abs(prop.keys[best]!.time - t)) best = i;
    }
    return best;
  };
  const key = (i: number): MockKey => {
    const k = prop.keys[i - 1];
    if (!k) throw new Error(`no key ${i} on ${prop.matchName}`);
    return k;
  };
  // A key that was never eased has a flat ease per dimension.
  const flatEases = (): MockEase[] => Array.from({ length: easeCount(prop.propertyValueType) }, () => ({ speed: 0, influence: 16.667 }));
  p.keyInTemporalEase = (i: number): MockEase[] => key(i).inEase ?? flatEases();
  p.keyOutTemporalEase = (i: number): MockEase[] => key(i).outEase ?? flatEases();
  p.setValueAtTime = (t: number, v: unknown): void => {
    const at = prop.keys.findIndex((k) => Math.abs(k.time - t) < 1e-9);
    // After Effects makes new keys bezier with its default ease; position keys get an automatic curve.
    if (at >= 0) prop.keys[at]!.value = v;
    else prop.keys.push({ time: t, value: v, inType: KIT.LINEAR, outType: KIT.LINEAR, autoBezier: true } as MockKey);
    prop.keys.sort((a, b) => a.time - b.time);
    if (prop.keys.length === 1) prop.value = v;
  };
  p.nearestKeyIndex = (t: number): number => find(t) + 1;
  p.setTemporalEaseAtKey = (i: number, inEase: KeyframeEase[], outEase: KeyframeEase[]): void => {
    const n = easeCount(prop.propertyValueType);
    if (inEase.length !== n || outEase.length !== n) throw new Error(`${prop.matchName} wants ${n} eases per side, got ${inEase.length} and ${outEase.length}`);
    const k = key(i);
    k.inEase = inEase.map((e) => ({ speed: e.speed, influence: e.influence }));
    k.outEase = outEase.map((e) => ({ speed: e.speed, influence: e.influence }));
    // Like After Effects: an ease makes both sides bezier.
    k.inType = KIT.BEZIER;
    k.outType = KIT.BEZIER;
  };
  p.setInterpolationTypeAtKey = (i: number, inType: string, outType: string): void => {
    const k = key(i);
    k.inType = inType;
    k.outType = outType ?? inType;
  };
  p.setSpatialTangentsAtKey = (i: number, inTan: number[], outTan: number[]): void => {
    const k = key(i);
    k.inTan = inTan;
    k.outTan = outTan;
  };
  p.setSpatialAutoBezierAtKey = (i: number, on: boolean): void => {
    (key(i) as MockKey & { autoBezier?: boolean }).autoBezier = on;
  };
  p.setSpatialContinuousAtKey = (): void => undefined;
  p.setRovingAtKey = (i: number, on: boolean): void => {
    key(i).roving = on;
  };
  p.removeKey = (i: number): void => {
    key(i);
    prop.keys.splice(i - 1, 1);
  };
  return prop;
}

const newProp = (matchName: string, type: string, value: unknown): Prop => writable(new Prop(matchName, type, value));

/** What After Effects puts into a shape item, an effect or a dash list when it is added. */
function contentsOf(matchName: string): Array<Prop | Group> | null {
  const one = (mn: string, v: number): Prop => newProp(mn, PVT.OneD, v);
  switch (matchName) {
    case 'ADBE Vector Group':
      return [
        buildable(new Group('ADBE Vectors Group', [])),
        new Group('ADBE Vector Transform Group', [
          newProp('ADBE Vector Anchor', PVT.TwoD_SPATIAL, [0, 0]),
          newProp('ADBE Vector Position', PVT.TwoD_SPATIAL, [0, 0]),
          newProp('ADBE Vector Scale', PVT.TwoD, [100, 100]),
          one('ADBE Vector Skew', 0),
          one('ADBE Vector Rotation', 0),
          one('ADBE Vector Group Opacity', 100),
        ]),
      ];
    case 'ADBE Vector Shape - Rect':
      return [newProp('ADBE Vector Rect Size', PVT.TwoD, [100, 100]), newProp('ADBE Vector Rect Position', PVT.TwoD_SPATIAL, [0, 0]), one('ADBE Vector Rect Roundness', 0)];
    case 'ADBE Vector Shape - Ellipse':
      return [newProp('ADBE Vector Ellipse Size', PVT.TwoD, [100, 100]), newProp('ADBE Vector Ellipse Position', PVT.TwoD_SPATIAL, [0, 0])];
    case 'ADBE Vector Shape - Group':
      return [newProp('ADBE Vector Shape', PVT.SHAPE, new Shape())];
    case 'ADBE Vector Graphic - Fill':
      return [newProp('ADBE Vector Fill Color', PVT.COLOR, [1, 0, 0, 1]), one('ADBE Vector Fill Opacity', 100), one('ADBE Vector Fill Rule', 1)];
    case 'ADBE Vector Graphic - Stroke':
      return [
        newProp('ADBE Vector Stroke Color', PVT.COLOR, [1, 1, 1, 1]),
        one('ADBE Vector Stroke Opacity', 100),
        one('ADBE Vector Stroke Width', 2),
        one('ADBE Vector Stroke Line Cap', 1),
        one('ADBE Vector Stroke Line Join', 1),
        one('ADBE Vector Stroke Miter Limit', 4),
        buildable(new Group('ADBE Vector Stroke Dashes', [])),
      ];
    case 'ADBE Vector Filter - Trim':
      return [one('ADBE Vector Trim Start', 0), one('ADBE Vector Trim End', 100), one('ADBE Vector Trim Offset', 0), one('ADBE Vector Trim Type', 1)];
    case 'ADBE Vector Filter - RC':
      return [one('ADBE Vector RoundCorner Radius', 10)];
    case 'ADBE Drop Shadow': {
      const opacity = one('ADBE Drop Shadow-0002', 127.5);
      opacity.hasMax = true;
      opacity.maxValue = 255;
      return [newProp('ADBE Drop Shadow-0001', PVT.COLOR, [0, 0, 0, 1]), opacity, one('ADBE Drop Shadow-0003', 135), one('ADBE Drop Shadow-0004', 5), one('ADBE Drop Shadow-0005', 0), one('ADBE Drop Shadow-0006', 0)];
    }
    default:
      return null;
  }
}

/** Gives a group After Effects' addProperty. */
export function buildable(group: Group): Group {
  (group as Group & { addProperty(mn: string): Prop | Group }).addProperty = (matchName: string): Prop | Group => {
    let made: Prop | Group;
    if (/^ADBE Vector Stroke (Dash|Gap) \d$/.test(matchName)) made = newProp(matchName, PVT.OneD, 10);
    else {
      const contents = contentsOf(matchName);
      if (!contents) throw new Error(`addProperty: the stand-in does not know "${matchName}"`);
      made = new Group(matchName, contents);
    }
    group.items.push(made);
    return made;
  };
  return group;
}

/** After Effects' TextDocument, as far as host.jsx reads and writes it. */
export class TextDocument {
  text: string;
  fontFamily = 'Myriad Pro';
  fontStyle = 'Regular';
  fontSize = 36;
  applyFill = true;
  fillColor = [1, 1, 1];
  applyStroke = false;
  strokeColor = [0, 0, 0];
  strokeWidth = 0;
  justification = 'LEFT_JUSTIFY';
  tracking = 0;
  leading = 0;
  boxText = false;
  boxTextSize: number[] | null = null;
  private boxPos: number[] | null = null;
  fontCapsOption = 'FONT_NORMAL_CAPS';
  private postScript = 'MyriadPro-Regular';

  constructor(text: string, box?: number[]) {
    this.text = text;
    if (box) {
      this.boxText = true;
      this.boxTextSize = box;
      this.boxPos = [-box[0]! / 2, -box[1]! / 2];
    }
  }
  get font(): string {
    return this.postScript;
  }
  /** "Family-Style" is how the stand-in's fonts are named, which is also what host.jsx guesses. */
  set font(name: string) {
    this.postScript = name;
    const at = name.lastIndexOf('-');
    this.fontFamily = at > 0 ? name.slice(0, at) : name;
    this.fontStyle = at > 0 ? name.slice(at + 1) : 'Regular';
  }
  get boxTextPos(): number[] | null {
    return this.boxPos;
  }
  /** Like After Effects 2027, which keeps a text box where it is. */
  set boxTextPos(_pos: number[] | null) {
    throw new Error('boxTextPos is read-only');
  }
  get allCaps(): boolean {
    return this.fontCapsOption === 'FONT_ALL_CAPS';
  }
  get smallCaps(): boolean {
    return this.fontCapsOption === 'FONT_SMALL_CAPS';
  }
  resetCharStyle(): void {}
  resetParagraphStyle(): void {}
  private lines(): string[] {
    return this.text.split('\r');
  }
  private lineHeight(): number {
    return this.leading > 0 ? this.leading : this.fontSize * 1.2;
  }
  /** A glyph is half its size wide and seven tenths high: good enough to place text by. */
  width(): number {
    return Math.max(...this.lines().map((l) => l.length)) * this.fontSize * 0.5;
  }
  private left(): number {
    if (this.boxPos) return this.boxPos[0]!;
    const w = this.width();
    return this.justification === 'CENTER_JUSTIFY' ? -w / 2 : this.justification === 'RIGHT_JUSTIFY' ? -w : 0;
  }
  private firstLine(): number {
    return this.boxPos ? this.boxPos[1]! + this.fontSize * 0.8 : 0;
  }
  get baselineLocs(): number[] {
    const out: number[] = [];
    this.lines().forEach((_, i) => out.push(this.left(), this.firstLine() + i * this.lineHeight(), this.left() + this.width(), this.firstLine() + i * this.lineHeight()));
    return out;
  }
  rect(): { left: number; top: number; width: number; height: number } {
    return { left: this.left(), top: this.firstLine() - this.fontSize * 0.7, width: this.width(), height: this.fontSize * 0.7 + (this.lines().length - 1) * this.lineHeight() };
  }
}

function newTransform(comp: CompItem): Group {
  const position = newProp('ADBE Position', PVT.ThreeD_SPATIAL, [comp.width / 2, comp.height / 2, 0]);
  (position as unknown as { dimensionsSeparated: boolean }).dimensionsSeparated = false;
  return new Group('ADBE Transform Group', [
    newProp('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [0, 0, 0]),
    position,
    newProp('ADBE Position_0', PVT.OneD, comp.width / 2),
    newProp('ADBE Position_1', PVT.OneD, comp.height / 2),
    newProp('ADBE Scale', PVT.ThreeD, [100, 100, 100]),
    newProp('ADBE Rotate Z', PVT.OneD, 0),
    newProp('ADBE Opacity', PVT.OneD, 100),
  ]);
}

/** A project that can be built into: items come and go, and compositions take new layers. */
export interface MockProject {
  items: unknown[];
  /** Files "on disk", by path. */
  files: Map<string, string>;
  /** Every undo step a script closed, by name. */
  undoNames: string[];
}

/**
 * Puts a project in place that host.jsx can build into, on top of
 * installAeGlobals. `files` are the files the script may read (the plan) or
 * import (images).
 */
export function installAeProject(files: Map<string, string> = new Map()): MockProject {
  const project: MockProject = { items: [], files, undoNames: [] };
  let nextId = 100;
  installAeGlobals(null, new Map(), project.items);
  const g = globalThis as unknown as { app: { project: Record<string, unknown>; beginUndoGroup(name: string): void; fonts?: unknown } } & Record<string, unknown>;
  const rootFolder = { name: 'Root' };

  const addLayerMethods = (comp: CompItem): void => {
    const place = (name: string, matchName: string, groups: Group[], extra: Record<string, unknown>): MockLayer => {
      const transform = newTransform(comp);
      const layer = makeLayer(comp, name, matchName, [transform, buildable(new Group('ADBE Effect Parade', [])), ...groups], extra);
      // A new layer goes on top.
      comp.layers.pop();
      comp.layers.unshift(layer);
      comp.layers.forEach((l, i) => (l.index = i + 1));
      layer.setParentWithJump = (parent: MockLayer): void => {
        layer.parent = parent;
      };
      layer.setTrackMatte = (matte: MockLayer, type: string): void => {
        layer.hasTrackMatte = true;
        layer.trackMatteLayer = matte;
        layer.trackMatteType = type;
        matte.isTrackMatte = true;
      };
      return layer;
    };
    const textLayer = (td: TextDocument): MockLayer => {
      const doc = newProp('ADBE Text Document', PVT.TEXT_DOCUMENT, td);
      const layer = place(td.text, 'ADBE Text Layer', [new Group('ADBE Text Properties', [doc, new Group('ADBE Text Animators', [])])], {});
      layer.sourceRectAtTime = (): unknown => (doc.value as TextDocument).rect();
      return layer;
    };
    Object.assign(comp.layers, {
      addShape: (): MockLayer => place('Shape Layer 1', 'ADBE Vector Layer', [buildable(new Group('ADBE Root Vectors Group', []))], {}),
      addText: (text: string): MockLayer => textLayer(new TextDocument(text)),
      addBoxText: (size: number[], text: string): MockLayer => textLayer(new TextDocument(text, size)),
      addNull: (): MockLayer => {
        const source = new FootageItem(nextId++, 'Null 1', 100, 100, new SolidSource([1, 1, 1]));
        project.items.push(source);
        return place('Null 1', 'ADBE AV Layer', [], { nullLayer: true, source, width: 100, height: 100 });
      },
      addSolid: (color: number[], name: string, w: number, h: number): MockLayer => {
        const source = new FootageItem(nextId++, name, w, h, new SolidSource(color));
        project.items.push(source);
        return place(name, 'ADBE AV Layer', [], { source, width: w, height: h });
      },
      add: (item: CompItem | FootageItem): MockLayer => {
        const layer = place(item.name, 'ADBE AV Layer', [newProp('ADBE Time Remapping', PVT.OneD, 0) as unknown as Group], { source: item, width: item.width, height: item.height });
        if (item instanceof CompItem) {
          item.usedIn.push(comp);
          layer.outPoint = item.duration;
        }
        return layer;
      },
    });
  };

  class MockFile {
    fsName: string;
    name: string;
    encoding = '';
    constructor(path: string) {
      this.fsName = path;
      this.name = path.slice(path.lastIndexOf('/') + 1);
    }
    get exists(): boolean {
      return files.has(this.fsName);
    }
    open(): boolean {
      return files.has(this.fsName);
    }
    read(): string {
      return files.get(this.fsName) ?? '';
    }
    close(): void {}
  }

  const live = g.app.project;
  Object.defineProperty(live, 'numItems', { get: () => project.items.length });
  live.item = (i: number): unknown => project.items[i - 1] ?? null;
  live.itemByID = (id: number): unknown => project.items.find((it) => (it as { id?: number }).id === id) ?? null;
  live.file = null;
  live.rootFolder = rootFolder;
  live.selection = [];
  live.items = {
    addComp: (name: string, w: number, h: number, _aspect: number, duration: number, frameRate: number): CompItem => {
      if (!(w >= 4 && h >= 4 && w === Math.round(w) && h === Math.round(h))) throw new Error(`addComp: ${w} x ${h} is not a size After Effects takes`);
      if (!(duration > 0) || !(frameRate >= 1 && frameRate <= 99)) throw new Error('addComp: bad duration or frame rate');
      const comp = new CompItem(nextId++, name, w, h, duration, frameRate);
      addLayerMethods(comp);
      project.items.push(comp);
      return comp;
    },
    addFolder: (name: string): unknown => {
      const folder = { id: nextId++, name, parentFolder: rootFolder };
      project.items.push(folder);
      return folder;
    },
  };
  live.importFile = (options: { file: MockFile }): FootageItem => {
    if (!files.has(options.file.fsName)) throw new Error('importFile: no such file');
    const item = new FootageItem(nextId++, options.file.name, 64, 32, new FileSource(options.file.fsName, true));
    project.items.push(item);
    return item;
  };
  const begin = g.app.beginUndoGroup;
  g.app.beginUndoGroup = (name: string): void => {
    project.undoNames.push(name);
    begin(name);
  };
  Object.assign(g, {
    File: MockFile,
    Folder: { myDocuments: { fsName: 'C:/Users/test/Documents' } },
    ImportOptions: class {
      file: MockFile;
      sequence = false;
      importAs = '';
      constructor(file: MockFile) {
        this.file = file;
      }
      canImportAs(): boolean {
        return true;
      }
    },
    ImportAsType: { FOOTAGE: 'FOOTAGE' },
    KeyframeEase,
    Shape,
    FontCapsOption: { FONT_NORMAL_CAPS: 'FONT_NORMAL_CAPS', FONT_ALL_CAPS: 'FONT_ALL_CAPS', FONT_SMALL_CAPS: 'FONT_SMALL_CAPS' },
    FolderItem: class {},
  });
  return project;
}
