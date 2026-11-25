/**
 * Compound shapes (holes), where things are put on the Figma page, several
 * compositions in one transfer, and the list of compositions the panel
 * offers.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { RawDump, RawShapeItem } from '../shared/ae-raw.ts';
import { convertAeDump } from '../shared/ae-convert.ts';
import { BUNDLE_NAME, packDocs, unpackDocs } from '../shared/format.ts';
import type { BridgeDoc, Comp, Layer, SubPath } from '../shared/format.ts';
import { closedForFill, reversed, signedArea } from '../shared/geometry.ts';
import { groupNotes, whereLabel } from '../shared/notes.ts';
import { arrange, buildDocument, newShared, occupied } from '../figma-plugin/src/build/builder.ts';
import type { Shared } from '../figma-plugin/src/build/builder.ts';
import { CompItem, installAeGlobals } from './mock-ae.ts';
import type { MockFigma, MockNode } from './sim.ts';
import { compOf, docOf, findNode, installMockFigma, solidLayer, transform, vec, vecKeys } from './sim.ts';

// ------------------------------------------------------------------- holes

/** A square outline the way vector artwork often arrives: "open", with its last point on its first. */
function square(x0: number, y0: number, x1: number, y1: number, clockwise: boolean): NonNullable<RawShapeItem['path']> {
  const ring = clockwise ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
  const v = [...ring, ring[0]!];
  return { closed: 0, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]) };
}

function shapeDump(items: RawShapeItem[]): RawDump {
  return {
    host: 'test', ae: 'test', project: null, rootId: '1', poster: 0, footage: {}, warnings: [],
    comps: {
      '1': {
        id: '1', name: 'Logo', w: 400, h: 400, duration: 2, frameRate: 25, bg: [1, 0.5, 0],
        layers: [{
          index: 1, name: 'o', enabled: 1, inPoint: 0, outPoint: 2, startTime: 0, stretch: 100, parent: null, type: 'shape', w: 400, h: 400,
          tr: { a: { v: [0, 0, 0] }, p: { v: [0, 0, 0] }, s: { v: [100, 100, 100] }, r: { v: 0 }, o: { v: 100 } },
          shape: [{ mn: 'ADBE Vector Group', name: 'o', items }],
        }],
      },
    },
  };
}

function builtVector(items: RawShapeItem[]): { node: MockNode; warnings: string[] } {
  const { doc } = convertAeDump(shapeDump(items));
  installMockFigma();
  const out = buildDocument({ doc, images: {}, fonts: new Map(), components: false });
  const node = findNode(out.frame as unknown as MockNode, 'o', 'VECTOR');
  assert.ok(node, 'the letter is one vector');
  return { node, warnings: doc.warnings.map((w) => w.message) };
}

/** The corner points of each outline in path data, in drawing order. */
function outlines(data: string): number[][][] {
  return data
    .split('M')
    .filter((part) => part.trim())
    .map((part) => {
      const nums = part.replace(/[LZ]/g, ' ').trim().split(/\s+/).map(Number);
      const points: number[][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
      return points;
    });
}

const area = (points: number[][]): number => points.reduce((a, p, i) => a + p[0]! * points[(i + 1) % points.length]![1]! - points[(i + 1) % points.length]![0]! * p[1]!, 0);

const FILL: RawShapeItem = { mn: 'ADBE Vector Graphic - Fill', name: 'Fill 1', color: { v: [1, 1, 1, 1] }, opacity: { v: 100 }, rule: { v: 1 } };
const path = (name: string, p: NonNullable<RawShapeItem['path']>): RawShapeItem => ({ mn: 'ADBE Vector Shape - Group', name, path: p });

test('the counter of a letter stays a hole: its outlines go to Figma as one compound path', () => {
  // Like the "o" of a logo: the counter first, the outer outline second, drawn in opposite directions.
  const { node } = builtVector([path('Path 1', square(150, 150, 250, 250, false)), path('Path 2', square(100, 100, 300, 300, true)), FILL]);
  assert.equal(node.vectorPaths.length, 1, 'one path, so one outline can cut into the other');
  const only = node.vectorPaths[0]!;
  assert.equal(only.windingRule, 'NONZERO');
  const rings = outlines(only.data);
  assert.equal(rings.length, 2, 'both outlines are in it');
  assert.equal((only.data.match(/Z/g) ?? []).length, 2, 'and both are closed, although After Effects called them open');
  assert.ok(area(rings[0]!) * area(rings[1]!) < 0, 'they still run in opposite directions, which is what makes the hole');
  assert.deepEqual(rings[0], [[50, 50], [50, 150], [150, 150], [150, 50], [50, 50]], 'the doubled end point is gone and the outline closes on its start');

  const evenOdd = builtVector([path('Path 1', square(150, 150, 250, 250, true)), path('Path 2', square(100, 100, 300, 300, true)), { ...FILL, rule: { v: 2 } }]);
  assert.equal(evenOdd.node.vectorPaths[0]!.windingRule, 'EVENODD');
});

test('Merge Paths is expressed through the winding rule', () => {
  const outer = path('Outer', square(100, 100, 300, 300, true));
  const inner = path('Inner', square(150, 150, 250, 250, true));
  const merge = (mode: number): RawShapeItem => ({ mn: 'ADBE Vector Filter - Merge', name: 'Merge Paths 1', mode: { v: mode } });

  // Subtract: the second outline is turned round so that it empties the first.
  const subtract = builtVector([outer, inner, merge(3), FILL]);
  const rings = outlines(subtract.node.vectorPaths[0]!.data);
  assert.ok(area(rings[0]!) * area(rings[1]!) < 0);
  assert.equal(subtract.node.vectorPaths[0]!.windingRule, 'NONZERO');
  assert.deepEqual(subtract.warnings, []);

  // Add: both run the same way, so nothing is cut out even if they were drawn in opposite directions.
  const add = builtVector([outer, path('Inner', square(150, 150, 250, 250, false)), merge(2), FILL]);
  const added = outlines(add.node.vectorPaths[0]!.data);
  assert.ok(area(added[0]!) * area(added[1]!) > 0);

  assert.equal(builtVector([outer, inner, merge(5), FILL]).node.vectorPaths[0]!.windingRule, 'EVENODD', 'exclude intersections');
  assert.ok(builtVector([outer, inner, merge(4), FILL]).warnings.some((w) => w.includes('Intersect')), 'intersect cannot be said this way and is reported');
});

test('outlines without a fill stay separate paths, and open ends stay open under a stroke', () => {
  const stroke: RawShapeItem = { mn: 'ADBE Vector Graphic - Stroke', name: 'Stroke 1', color: { v: [0, 0, 0, 1] }, opacity: { v: 100 }, width: { v: 4 } };
  const { node } = builtVector([path('A', square(0, 0, 100, 100, true)), path('B', square(200, 0, 300, 100, true)), stroke]);
  assert.deepEqual(node.vectorPaths.map((p) => p.windingRule), ['NONE', 'NONE']);

  const open: SubPath = { closed: false, v: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], i: [], o: [] };
  assert.equal(closedForFill(open, true), open, 'a real gap is kept when a stroke would show the closing line');
  assert.equal(closedForFill(open, false).closed, true);
  assert.ok(signedArea(open) * signedArea(reversed(open)) < 0);
});

// ----------------------------------------------------- placing on the page

function logoDoc(name: string, sizes: Array<[number, number]> = [[400, 300], [400, 300]]): BridgeDoc {
  const mark = (label: string): Layer => solidLayer('1', label, 120, 80, { position: vec(10, 10) });
  const variants = sizes.map(([w, h], i) => compOf(`${name}-logo${i}`, [mark(`Mark ${i}`)], 2, w, h));
  const logo: Layer = {
    id: '1', name: 'Logo', inPoint: 0, outPoint: 3,
    transform: transform({ position: vec(100, 100) }),
    content: { type: 'comp', compId: variants[0]!.id, width: sizes[0]![0], height: sizes[0]![1], startTime: 0, setId: 'setLogo' },
  };
  const badge: Layer = {
    id: '2', name: 'Badge', inPoint: 0, outPoint: 3,
    transform: transform({ position: vec(500, 100) }),
    content: { type: 'comp', compId: `${name}-badge`, width: 200, height: 200, startTime: 0 },
  };
  const main: Comp = { ...compOf(`${name}-main`, [logo, badge, solidLayer('3', 'BG', 800, 600, {})], 3), name };
  const doc = docOf([main, ...variants, compOf(`${name}-badge`, [mark('Dot')], 2, 200, 200)]);
  doc.sets = {
    setLogo: {
      id: 'setLogo', name: 'Logo',
      props: [{ name: 'Brand', values: variants.map((_, i) => `Brand ${i}`) }],
      variants: variants.map((v, i) => ({ compId: v.id, choice: [i] })),
    },
  };
  return doc;
}

interface Box { x: number; y: number; w: number; h: number; name: string }
const boxOf = (n: MockNode): Box => ({ x: n.x, y: n.y, w: n.width, h: n.height, name: `${n.type} ${n.name}` });
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function assertApart(nodes: MockNode[], label: string): void {
  const boxes = nodes.map(boxOf);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!overlap(boxes[i]!, boxes[j]!), `${label}: "${boxes[i]!.name}" and "${boxes[j]!.name}" overlap`);
    }
  }
}

function assertInside(parent: MockNode, label: string): void {
  for (const child of parent.children) {
    assert.ok(child.x >= 0 && child.y >= 0 && child.x + child.width <= parent.width + 1e-6 && child.y + child.height <= parent.height + 1e-6, `${label}: "${child.name}" sticks out of "${parent.name}"`);
  }
}

function buildAll(docs: BridgeDoc[], setup?: (mock: MockFigma) => void) {
  const mock = installMockFigma();
  setup?.(mock);
  const taken = occupied();
  const builds = docs.map((doc) => buildDocument({ doc, images: {}, fonts: new Map(), components: true }));
  const placed = arrange(builds, taken);
  return { mock, page: mock.currentPage as MockNode, builds, placed, taken };
}

test('frames go in a row clear of what is on the page, each with its components in a section', () => {
  const { page, placed, taken } = buildAll([logoDoc('Social 4x5'), logoDoc('Social 1x1', [[400, 300], [600, 200], [300, 500]])], (mock) => {
    const old = mock.createFrame();
    old.name = 'Earlier work';
    old.x = 100;
    old.y = 50;
    old.resize(800, 600);
  });
  assert.deepEqual(taken, { x: 100, y: 50, w: 800, h: 600 });
  assert.deepEqual(placed.warnings, []);

  const [a, b] = placed.frames as unknown as MockNode[];
  assert.deepEqual([a!.x, a!.y], [100, 1050], 'below what was there, with room to spare');
  assert.deepEqual([b!.x, b!.y], [1100, 1050], 'the second frame beside the first');

  assert.deepEqual(page.children.map((c) => `${c.type} ${c.name}`), [
    'SECTION Social 1x1 · Components', 'SECTION Social 4x5 · Components', 'FRAME Earlier work', 'FRAME Social 4x5', 'FRAME Social 1x1',
  ], 'nothing else is loose on the page, and the sections lie behind everything');
  assertApart(page.children, 'page');
  const firstSection = placed.sections[0] as unknown as MockNode;
  assert.equal(firstSection.x - (b!.x + b!.width), 1200, 'the components keep well clear of the designs');
  assert.equal(firstSection.y, a!.y);

  for (const section of placed.sections as unknown as MockNode[]) {
    // In the order of the After Effects timeline: the logo layer is above the badge.
    assert.deepEqual(section.children.map((c) => `${c.type} ${c.name.replace(/^Social ...-/, '')}`), ['COMPONENT_SET Logo', 'COMPONENT badge']);
    assertApart(section.children, section.name);
    assertInside(section, section.name);
    const set = section.children[0]!;
    assertApart(set.children, 'variants');
    assertInside(set, 'variants');
  }
  // Still the same components: the instance in the frame points into the section.
  const instance = findNode(a!, 'Logo', 'INSTANCE');
  assert.equal(instance?.mainComponent?.parent?.parent?.name, 'Social 4x5 · Components');
});

test('on an empty page the frame is centred in view; without components there is no section', () => {
  const plain = docOf([compOf('Plain', [solidLayer('1', 'Box', 100, 100, {})], 2, 800, 600)]);
  const { page, placed } = buildAll([plain], (mock) => {
    mock.viewport.center = { x: 1000, y: 500 };
  });
  const frame = placed.frames[0] as unknown as MockNode;
  assert.deepEqual([frame.x, frame.y], [600, 200]);
  assert.deepEqual(placed.sections, []);
  assert.deepEqual(page.children.map((c) => c.type), ['FRAME']);
});

test('if Figma would lose animation inside a section, the components stay on the page - still tidy', () => {
  const { page, placed } = buildAll([logoDoc('Social 4x5')], (mock) => {
    mock.sectionsBreakMotion = true;
  });
  assert.deepEqual(placed.sections, []);
  assert.ok(placed.warnings.some((w) => w.includes('section')));
  assert.deepEqual(page.children.map((c) => c.type).sort(), ['COMPONENT', 'COMPONENT_SET', 'FRAME']);
  assertApart(page.children, 'page');
  const set = page.children.find((c) => c.type === 'COMPONENT_SET')!;
  assert.ok(findNode(set, 'Mark 0', 'RECTANGLE')?.tracks !== undefined);
});

/** Where a node is on the page, whatever it sits in. */
const pageBox = (n: MockNode): Box => ({ x: n.absoluteTransform[0][2], y: n.absoluteTransform[1][2], w: n.width, h: n.height, name: `${n.type} ${n.name}` });

test('components end up inside their section on the page, however Figma treats nodes handed to a section', () => {
  const quirks: Array<[string, (mock: MockFigma) => void, number]> = [
    ['x and y are kept', () => undefined, 0],
    ['the place on the page is kept', (mock) => { mock.sectionsKeepPlace = true; }, 0],
    ['only what lies inside is taken in', (mock) => { mock.sectionsNeedInside = true; }, 0],
    ['component sets are not taken in', (mock) => { mock.sectionsRefuse.add('COMPONENT_SET'); }, 1],
  ];
  for (const [label, setup, outside] of quirks) {
    const { page, placed, builds } = buildAll([logoDoc('Social 4x5')], setup);
    const section = placed.sections[0] as unknown as MockNode;
    assert.ok(section, `${label}: there is a section`);
    const frame = placed.frames[0] as unknown as MockNode;
    const area = pageBox(section);
    const components = builds[0]!.components as unknown as MockNode[];
    assert.equal(components.length, 2);
    for (const c of components) {
      const box = pageBox(c);
      assert.ok(box.x >= area.x && box.y >= area.y && box.x + box.w <= area.x + area.w && box.y + box.h <= area.y + area.h, `${label}: "${box.name}" lies within the section`);
      assert.ok(box.x - (frame.x + frame.width) >= 1200, `${label}: "${box.name}" keeps clear of the design`);
    }
    const boxes = components.map(pageBox);
    assert.ok(!overlap(boxes[0]!, boxes[1]!), `${label}: the components do not overlap`);
    assert.deepEqual([boxes[0]!.x - area.x, boxes[0]!.y - area.y], [160, 160], `${label}: the first sits in the corner of the section, with room around it`);
    assert.equal(components.filter((c) => c.parent !== section).length, outside, `${label}: how many stay on the page`);
    assert.equal(placed.warnings.some((w) => w.includes('out of their section')), outside > 0, `${label}: says so when one stays out`);
    assert.equal(page.children[0], section, `${label}: the section lies behind everything, so nothing is hidden by it`);
  }
});

test('a set with many versions is laid out as a wide block with full rows', () => {
  const sizes: Array<[number, number]> = Array.from({ length: 21 }, () => [540, 960] as [number, number]);
  const { builds } = buildAll([logoDoc('Markets', sizes)]);
  const set = (builds[0]!.components as unknown as MockNode[]).find((c) => c.type === 'COMPONENT_SET')!;
  assert.equal(new Set(set.children.map((c) => c.x)).size, 7, 'seven columns');
  assert.equal(new Set(set.children.map((c) => c.y)).size, 3, 'three full rows');
  assert.ok(set.width > set.height);
  assertApart(set.children, 'variants');
  assertInside(set, 'variants');
});

// ------------------------------------------------------------------ pickers

/** A precomp with one picture per frame, held on one of them by an expression: an "image controller". */
function pickerDump(root: string, pickFrame: number, names = ['Burger.png', 'Pizza.png', 'Salad.png'], frozenBy: 'expression' | 'keys' = 'expression'): RawDump {
  const tr = { a: { v: [0, 0, 0] }, p: { v: [0, 0, 0] }, s: { v: [100, 100, 100] }, r: { v: 0 }, o: { v: 100 } };
  const picture = (i: number): RawDump['comps'][string]['layers'][number] => ({
    // The first picture is the lowest layer, as After Effects stacks them.
    index: names.length - i, name: names[i]!, enabled: 1, inPoint: i * 0.04, outPoint: (i + 1) * 0.04, startTime: i * 0.04, stretch: 100, parent: null,
    type: 'solid', w: 300, h: 200, src: `f${i}`, tr,
  });
  const footage: RawDump['footage'] = {};
  names.forEach((name, i) => {
    footage[`f${i}`] = { id: `f${i}`, name, w: 300, h: 200, still: 1, solid: [i / 4, 0.5, 0.2] } as RawDump['footage'][string];
  });
  return {
    host: 'test', ae: 'test', project: null, rootId: root, poster: 0, footage, warnings: [],
    comps: {
      [root]: {
        id: root, name: root, w: 800, h: 600, duration: 4, frameRate: 25, bg: [0, 0, 0],
        layers: [{
          index: 1, name: 'Image controller', enabled: 1, inPoint: 0, outPoint: 4, startTime: 0, stretch: 100, parent: null, type: 'precomp', w: 300, h: 200, src: '50',
          timeRemap: 1, remap: frozenBy === 'expression' ? { v: pickFrame * 0.04, ex: 1 } : { v: pickFrame * 0.04 }, tr,
        } as RawDump['comps'][string]['layers'][number]],
      },
      '50': {
        id: '50', name: 'Image controller', w: 300, h: 200, duration: 1, frameRate: 25, bg: [0, 0, 0],
        layers: names.map((_, i) => picture(names.length - 1 - i)),
      },
    },
  };
}

test('a picker - one picture per frame, held on one by an expression - arrives with every picture, as variants', () => {
  const { doc } = convertAeDump(pickerDump('Main', 1));
  const set = Object.values(doc.sets ?? {})[0]!;
  assert.deepEqual(set.props, [{ name: 'Version', values: ['Burger', 'Pizza', 'Salad'] }], 'named after the layers, without file endings');
  assert.deepEqual(set.variants.map((v) => [v.compId, v.choice, v.at]), [['50', [0], 0.02], ['50', [1], 0.06], ['50', [2], 0.1]], 'each held in the middle of its frame');
  const layer = doc.comps.Main!.layers[0]!;
  assert.ok(layer.content.type === 'comp' && layer.content.setId === set.id);
  assert.equal(layer.content.variant, 1, 'the layer shows the picture that is picked now');

  installMockFigma();
  const out = buildDocument({ doc, images: {}, fonts: new Map(), components: true });
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.motion.problems, []);
  const built = out.components[0] as unknown as MockNode;
  assert.equal(built.type, 'COMPONENT_SET');
  assert.deepEqual(built.children.map((c) => c.name), ['Version=Burger', 'Version=Pizza', 'Version=Salad']);
  assert.deepEqual(built.children.map((c) => c.children.map((l) => l.name)), [['Burger.png'], ['Pizza.png'], ['Salad.png']], 'each variant holds its own picture and nothing else');
  assert.ok(built.children.every((c) => c.children.every((l) => l.tracks.size === 0 && l.opacity === 1)), 'still and fully visible');
  const instance = findNode(out.frame as unknown as MockNode, 'Image controller', 'INSTANCE');
  assert.equal(instance?.mainComponent?.name, 'Version=Pizza');

  // Names nobody chose are replaced by numbers; pictures that are images make it an "Image" option.
  const hashed = convertAeDump(pickerDump('Main', 0, ['img-3fcac7085ebcb798@2x.png', 'img-130bf240082ca6b2@2x.png']));
  assert.deepEqual(Object.values(hashed.doc.sets ?? {})[0]!.props[0]!.values, ['1', '2']);

  // With components switched off the picked picture is simply built into the frame.
  installMockFigma();
  const flat = buildDocument({ doc, images: {}, fonts: new Map(), components: false });
  const frame = flat.frame as unknown as MockNode;
  assert.ok(findNode(frame, 'Pizza.png', 'RECTANGLE'));
  assert.equal(findNode(frame, 'Burger.png', 'RECTANGLE'), undefined);
});

test('an ordinary animation held on a frame is not mistaken for a picker', () => {
  // A freeze frame made with a key instead of an expression: nothing chooses between pictures here.
  assert.equal(convertAeDump(pickerDump('Main', 1, undefined, 'keys')).doc.sets, undefined);

  // Layers that come in one after the other and stay: versions without a picture of their own.
  const dump = pickerDump('Main', 2);
  for (const layer of dump.comps['50']!.layers) layer.outPoint = 1;
  assert.equal(convertAeDump(dump).doc.sets, undefined);
});

test('compositions that hold the same picker share one component set, also across transfers', () => {
  const mock = installMockFigma();
  const page = mock.currentPage as MockNode;
  const build = (root: string, pick: number, shared: Shared) => buildDocument({ doc: convertAeDump(pickerDump(root, pick)).doc, images: {}, fonts: new Map(), components: true, shared });
  const sets = (): MockNode[] => page.findAllWithCriteria({ types: ['COMPONENT_SET'] });

  // One transfer, two compositions with different pictures picked.
  const first = newShared(true);
  const a = build('Social 4x5', 2, first);
  const b = build('Social 1x1', 0, first);
  assert.equal(sets().length, 1, 'one set for both');
  assert.deepEqual([a.components.length, a.reused, b.components.length, b.reused], [1, 0, 0, 1]);
  const shown = (out: ReturnType<typeof build>): MockNode | null | undefined => findNode(out.frame as unknown as MockNode, 'Image controller', 'INSTANCE')?.mainComponent;
  assert.equal(shown(a)?.name, 'Version=Salad');
  assert.equal(shown(b)?.name, 'Version=Burger');
  assert.equal(shown(a)?.parent, shown(b)?.parent, 'both frames show variants of the same set');
  const placed = arrange([a, b], null);
  assert.equal(placed.sections.length, 1, 'and it sits in one section');

  // A later transfer finds the set on the page and uses it again.
  const c = build('Social 9x16', 1, newShared(true));
  assert.equal(sets().length, 1);
  assert.deepEqual([c.components.length, c.reused], [0, 1]);
  assert.equal(shown(c)?.parent, shown(a)?.parent);

  // Another picture in the picker is another picker: it gets a set of its own.
  const other = buildDocument({ doc: convertAeDump(pickerDump('Social 16x9', 0, ['Burger.png', 'Pizza.png', 'Wrap.png'])).doc, images: {}, fonts: new Map(), components: true, shared: newShared(true) });
  assert.equal(sets().length, 2);
  assert.equal(other.reused, 0);

  // If the designer deleted the set in between, it is simply built again.
  for (const set of sets()) set.remove();
  const again = build('Social 4x5', 2, newShared(true));
  assert.deepEqual([again.components.length, again.reused], [1, 0]);
});

test('animated components are shared within a transfer only when they play the same way', () => {
  const mark = (to: number): Layer => solidLayer('1', 'Mark', 120, 80, { position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 1, v: { x: to, y: 0 } }]) });
  const doc = (root: string, to: number, start: number): BridgeDoc => {
    const logo: Layer = {
      id: '1', name: 'Logo', inPoint: 0, outPoint: 3, transform: transform({}),
      content: { type: 'comp', compId: `${root}-logo`, width: 400, height: 300, startTime: start },
    };
    return docOf([{ ...compOf(root, [logo], 3), name: root }, { ...compOf(`${root}-logo`, [mark(to)], 2, 400, 300), name: 'Logo' }]);
  };
  installMockFigma();
  const shared = newShared();
  const outs = [doc('A', 100, 0), doc('B', 100, 0), doc('C', 100, 0.5), doc('D', 250, 0)].map((d) => buildDocument({ doc: d, images: {}, fonts: new Map(), components: true, shared }));
  assert.deepEqual(outs.map((o) => [o.components.length, o.reused]), [[1, 0], [0, 1], [1, 0], [1, 0]], 'B plays exactly what A plays; C starts later, D moves further');
  // A moving component is not picked up by a later transfer: it was built for one timeline.
  const later = buildDocument({ doc: doc('E', 100, 0), images: {}, fonts: new Map(), components: true, shared: newShared(true) });
  assert.deepEqual([later.components.length, later.reused], [1, 0]);
});

test('a still component is kept small and its instances are scaled back up; an animated one stays full size', () => {
  const picture = (moving: boolean): Layer =>
    solidLayer('1', 'Photo', 3000, 2000, moving ? { position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 1, v: { x: 50, y: 0 } }]) } : {});
  const doc = (root: string, scale: number, moving: boolean): BridgeDoc => {
    const layer: Layer = {
      id: '1', name: 'Photo precomp', inPoint: 0, outPoint: 3,
      transform: transform({ position: vec(100, 50), scale: vec(scale, scale) }),
      content: { type: 'comp', compId: 'photo', width: 3000, height: 2000, startTime: 0 },
    };
    return docOf([{ ...compOf(root, [layer], 3), name: root }, { ...compOf('photo', [picture(moving)], 3, 3000, 2000), name: 'Photo' }]);
  };
  installMockFigma();
  const shared = newShared();
  const [half, quarter] = [doc('A', 0.5, false), doc('B', 0.25, false)].map((d) => buildDocument({ doc: d, images: {}, fonts: new Map(), components: true, shared }));
  const component = half!.components[0] as unknown as MockNode;
  assert.deepEqual([Math.round(component.width), Math.round(component.height)], [1000, 667], 'three times smaller than the composition');
  assert.equal(quarter!.reused, 1, 'both frames use it');
  const sizeIn = (out: typeof half): number[] => {
    const instance = findNode(out!.frame as unknown as MockNode, 'Photo precomp', 'INSTANCE')!;
    assert.equal(instance.mainComponent, component);
    return [Math.round(instance.width), Math.round(instance.height), Math.round(instance.x), Math.round(instance.y)];
  };
  assert.deepEqual(sizeIn(half), [1500, 1000, 100, 50], 'drawn at the size the layer has in After Effects');
  assert.deepEqual(sizeIn(quarter), [750, 500, 100, 50]);

  installMockFigma();
  const moving = buildDocument({ doc: doc('C', 0.5, true), images: {}, fonts: new Map(), components: true });
  assert.equal((moving.components[0] as unknown as MockNode).width, 3000, 'keyframes inside are measured in its own pixels, so it keeps its size');
});

// -------------------------------------------------- several compositions

test('one composition travels as a plain document, several as a bundle', () => {
  const a = logoDoc('A');
  const b = logoDoc('B');
  assert.equal(packDocs([a]), a);
  const bundle = packDocs([a, b]);
  assert.equal(bundle.format, BUNDLE_NAME);
  assert.deepEqual(unpackDocs(JSON.parse(JSON.stringify(bundle)))?.map((d) => d.rootCompId), ['A-main', 'B-main']);
  assert.deepEqual(unpackDocs(a), [a]);
  assert.equal(unpackDocs({ format: BUNDLE_NAME, docs: [] }), null);
  assert.equal(unpackDocs({ format: BUNDLE_NAME, docs: [a, { nonsense: true }] }), null);
  assert.equal(unpackDocs('text'), null);
});

test('equal notes are shown once, with the places they apply to', () => {
  const groups = groupNotes([
    { where: 'Logo A', text: 'Gradient fills cannot be read.' },
    { where: 'Logo B', text: 'Gradient fills cannot be read.' },
    { where: 'Logo B', text: 'Gradient fills cannot be read.' },
    { where: '', text: 'Motion is not available.' },
    { where: 'Logo C', text: 'Gradient fills cannot be read.' },
  ]);
  assert.deepEqual(groups, [
    { text: 'Gradient fills cannot be read.', count: 4, where: ['Logo A', 'Logo B', 'Logo C'] },
    { text: 'Motion is not available.', count: 1, where: [] },
  ]);
  assert.equal(whereLabel(groups[0]!.where), 'Logo A, Logo B, Logo C');
  assert.equal(whereLabel(['Launch - Social - 4x5 - en-EN', 'Launch - Social - 1x1 - en-EN', 'Launch - Social - 9x16']), 'Launch - Social - 4x5 - en-EN and 2 more', 'long names: one, and how many more');
});

test('the panel is told which compositions are deliverables and which are building blocks', () => {
  const main = new CompItem(10, 'Social 4x5', 1080, 1350, 6);
  const square = new CompItem(11, 'Social 1x1', 1080, 1080, 6);
  const logo = new CompItem(20, 'LOGO', 1080, 1920, 9.4);
  logo.usedIn = [main, square];
  logo.parentFolder = { name: 'Precomps' };
  installAeGlobals(main, new Map(), [main, { name: 'a folder' }, square, logo]);
  vm.runInThisContext(readFileSync(new URL('../ae-panel/host/host.jsx', import.meta.url), 'utf8'), { filename: 'host.jsx' });
  const host = (globalThis as unknown as { MOTIONBRIDGE: { listComps(): string; getStatus(): string } }).MOTIONBRIDGE;

  const found = JSON.parse(host.listComps()) as { ok: boolean; active: string; comps: Array<Record<string, unknown>> };
  assert.equal(found.ok, true);
  assert.equal(found.active, '10');
  assert.deepEqual(found.comps.map((c) => [c.id, c.name, c.w, c.h, c.nested, c.folder]), [
    ['10', 'Social 4x5', 1080, 1350, 0, ''],
    ['11', 'Social 1x1', 1080, 1080, 0, ''],
    ['20', 'LOGO', 1080, 1920, 1, 'Precomps'],
  ]);
  const status = JSON.parse(host.getStatus()) as { items: number; comp: { w: number; h: number } };
  assert.equal(status.items, 4);
  assert.deepEqual([status.comp.w, status.comp.h], [1080, 1350]);
});
