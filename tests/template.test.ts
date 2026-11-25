/**
 * What templates need on top of plain layers: motion from expressions fitted
 * back into eased keys, time remapping, track mattes, and options that turn
 * into components with variants - including reading those options out of
 * After Effects and leaving the project exactly as it was.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { RawController, RawDump, RawState, HostResult } from '../shared/ae-raw.ts';
import { convertAeDump, mergeDump, roundedBox } from '../shared/ae-convert.ts';
import { easeProgress, evalAnim, evalKeys, fitSamples, numOps, vecOps } from '../shared/anim.ts';
import type { Anim, BridgeDoc, Comp, Ease, Layer, Vec2 } from '../shared/format.ts';
import { buildDocument } from '../figma-plugin/src/build/builder.ts';
import { CompItem, FootageItem, Group, PVT, Prop, SolidSource, installAeGlobals, makeLayer, transformGroup, undo } from './mock-ae.ts';
import type { MockFigma, MockNode } from './sim.ts';
import {
  apply,
  compOf,
  docOf,
  findNode,
  installMockFigma,
  layerMatrix,
  mul,
  nodeSize,
  solidLayer,
  transform,
  vec,
  vecKeys,
  worldMatrix,
  worldOpacity,
} from './sim.ts';
import type { Mat } from './sim.ts';

const SNAP: Ease = { type: 'bezier', x1: 0.78, y1: 0, x2: 0, y2: 1 };

function near(a: Vec2, b: Vec2, label: string, eps = 0.05): void {
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= eps, `${label}: got (${a.x.toFixed(2)}, ${a.y.toFixed(2)}), expected (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
}

function build(doc: BridgeDoc, components: boolean, setup?: (mock: MockFigma) => void) {
  const mock = installMockFigma();
  setup?.(mock);
  const out = buildDocument({ doc, images: {}, fonts: new Map(), components });
  return { mock, out, root: out.frame as unknown as MockNode, page: mock.currentPage as MockNode };
}

/** Checks the corners of a w x h box drawn by `node` against a reference matrix over time. */
function follows(node: MockNode, toRoot: (t: number) => Mat, reference: (t: number) => Mat, w: number, h: number, duration: number): void {
  for (let t = 0; t <= duration + 1e-9; t += 0.05) {
    const size = nodeSize(node, t);
    for (const [u, v] of [[0, 0], [1, 1], [0.5, 0.5]] as Array<[number, number]>) {
      near(apply(toRoot(t), { x: u * size.x, y: v * size.y }), apply(reference(t), { x: u * w, y: v * h }), `"${node.name}" (${u},${v}) at t=${t.toFixed(2)}`);
    }
  }
}

// ------------------------------------------------------------ ease fitting

test('sampled motion is fitted back into holds and eased moves', () => {
  const times: number[] = [];
  const values: number[] = [];
  for (let f = 0; f <= 150; f++) {
    const t = f / 25;
    let v = 100;
    if (t >= 0.24 && t <= 1.2) v = 100 + 400 * easeProgress(SNAP, (t - 0.24) / 0.96);
    else if (t > 1.2 && t < 4.4) v = 500;
    else if (t >= 4.4 && t <= 5) v = 500 - 400 * easeProgress({ type: 'bezier', x1: 0.33, y1: 0, x2: 0.67, y2: 1 }, (t - 4.4) / 0.6);
    times.push(t);
    values.push(v);
  }
  const keys = fitSamples(times, values, numOps, 0.2);
  assert.deepEqual(keys.map((k) => k.t), [0, 0.24, 1.2, 4.4, 5, 6], 'one key where the value starts or stops moving');
  const move = keys[2]!.e;
  assert.ok(move && move.type === 'bezier');
  assert.ok(Math.abs(move.x1 - 0.78) < 0.01 && Math.abs(move.y1) < 0.01 && Math.abs(move.x2) < 0.01 && Math.abs(move.y2 - 1) < 0.01, 'the easing curve is found again');
  for (let i = 0; i < times.length; i++) {
    assert.ok(Math.abs(evalKeys(keys, times[i]!, numOps) - values[i]!) < 0.45, `stays on the samples at t=${times[i]}`);
  }

  // Points follow the same rules; something that never moves gives no keys.
  const points = values.map((v) => ({ x: v, y: 20 + v / 2 }));
  assert.equal(fitSamples(times, points, vecOps, 0.2).length, 6);
  assert.deepEqual(fitSamples(times, times.map(() => 7), numOps, 0.2), []);

  // A wobble no single curve can follow is cut into pieces, still within tolerance.
  const wave = times.map((t) => 50 * Math.sin(t * 3));
  const waveKeys = fitSamples(times, wave, numOps, 0.5);
  assert.ok(waveKeys.length > 4 && waveKeys.length < 60, `a sine wave needs several keys but not one per frame (${waveKeys.length})`);
  for (let i = 0; i < times.length; i++) assert.ok(Math.abs(evalKeys(waveKeys, times[i]!, numOps) - wave[i]!) < 0.6);
});

// -------------------------------------------------------- rounded-box paths

/** The outline a "roundy box" rig draws: eight points, one radius per corner. */
function rigBox(w: number, h: number, tl: number, tr: number, br: number, bl: number, cx = 0, cy = 0): number[] {
  return [
    -w / 2, -h / 2 + tl, -w / 2 + tl, -h / 2, w / 2 - tr, -h / 2, w / 2, -h / 2 + tr,
    w / 2, h / 2 - br, w / 2 - br, h / 2, -w / 2 + bl, h / 2, -w / 2, h / 2 - bl,
  ].map((n, i) => n + (i % 2 === 0 ? cx : cy));
}

test('a path that stays a rounded box becomes a rectangle with animated size and corners', () => {
  assert.deepEqual(roundedBox(rigBox(200, 100, 0, 0, 30, 30, 10, 5)), { cx: 10, cy: 5, w: 200, h: 100, r: [0, 0, 30, 30] });
  assert.equal(roundedBox([0, 0, 100, 0, 50, 80]), null, 'a triangle is not a box');
  assert.equal(roundedBox([0, 0, 100, 0, 100, 100, 40, 60, 0, 100]), null, 'a point inside the bounds rules it out');

  // The tab of a template: full frame at first, then eased down into a corner tab.
  const frames: number[][] = [];
  for (let f = 0; f <= 50; f++) {
    const p = easeProgress(SNAP, Math.min(1, f / 25));
    frames.push(rigBox(1000 - 800 * p, 800 - 600 * p, 0, 0, 40 * p, 40 * p));
  }
  const rest = rigBox(200, 200, 0, 0, 40, 40);
  const pairs = (flat: number[]): number[][] => flat.reduce<number[][]>((acc, n, i) => (i % 2 ? (acc[acc.length - 1]!.push(n), acc) : [...acc, [n]]), []);
  const dump: RawDump = {
    host: 'test', ae: 'test', project: null, rootId: '1', poster: 2, footage: {}, warnings: [],
    comps: {
      '1': {
        id: '1', name: 'Main', w: 1000, h: 800, duration: 2, frameRate: 25, bg: [0, 0, 0],
        layers: [{
          index: 1, name: 'TAB', enabled: 1, inPoint: 0, outPoint: 2, startTime: 0, stretch: 100, parent: null, type: 'shape', w: 1000, h: 800,
          tr: { a: { v: [0, 0, 0] }, p: { v: [500, 400, 0] }, s: { v: [100, 100, 100] }, r: { v: 0 }, o: { v: 100 } },
          shape: [
            { mn: 'ADBE Vector Shape - Group', name: 'Path 1', path: { closed: 1, v: pairs(rest), i: pairs(rest).map(() => [0, 0]), o: pairs(rest).map(() => [0, 0]), anim: 1, s: { dt: 0.04, f: frames } } },
            { mn: 'ADBE Vector Graphic - Fill', name: 'Fill 1', color: { v: [1, 0.5, 0, 1] }, opacity: { v: 100 } },
          ],
        }],
      },
    },
  };
  const { doc } = convertAeDump(dump);
  assert.deepEqual(doc.warnings, [], 'nothing about path morphing is reported');
  const tab = doc.comps['1']!.layers[0]!;
  assert.ok(tab.content.type === 'group');
  const rect = tab.content.children[0]!.content;
  assert.ok(rect.type === 'rect' && rect.radii && rect.size.mode === 'vec');
  assert.ok(rect.size.a.k && rect.size.a.k.length <= 4, `a few eased keys instead of one per frame (${rect.size.a.k?.length})`);

  const { root, out } = build(doc, false);
  assert.deepEqual(out.motion.problems, []);
  const node = findNode(root, 'TAB', 'RECTANGLE');
  assert.ok(node);
  assert.ok(node.tracks.has('WIDTH') && node.tracks.has('RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS') && !node.tracks.has('RECTANGLE_TOP_LEFT_CORNER_RADIUS'));
  assert.equal(node.bottomLeftRadius, 40);
  for (const t of [0, 0.4, 0.8, 1, 2]) {
    const p = easeProgress(SNAP, Math.min(1, t));
    const size = nodeSize(node, t);
    near(size, { x: 1000 - 800 * p, y: 800 - 600 * p }, `size at t=${t}`, 1.2);
    near(apply(worldMatrix(node, root, t), { x: size.x / 2, y: size.y / 2 }), { x: 500, y: 400 }, `stays centred at t=${t}`, 0.7);
  }
});

// ------------------------------------------------------------ time remapping

test('a time-remapped composition plays fast, freezes, and keeps its layers on time', () => {
  // Timeline 0-1 s runs through 2 s of the nested composition, then it stands still.
  const remap: Anim<number> = { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 2 }, { t: 3, v: 2 }] };
  const box = solidLayer('1', 'Box', 100, 60, { position: vecKeys([{ t: 0, v: { x: 0, y: 10 } }, { t: 3, v: { x: 300, y: 10 }, e: SNAP }]) });
  const blink = solidLayer('2', 'Blink', 40, 40, { position: vec(20, 200) }, { inPoint: 0.5, outPoint: 1.5 });
  const inner = compOf('inner', [box, blink], 3, 400, 300);
  const pre: Layer = {
    id: '1', name: 'Pre', transform: transform({ position: vec(50, 20) }), inPoint: 0, outPoint: 3,
    content: { type: 'comp', compId: 'inner', width: 400, height: 300, startTime: 0, remap },
  };
  const main = compOf('main', [pre], 3);
  const { root, out } = build(docOf([main, inner]), false);
  assert.deepEqual(out.motion.problems, []);

  const inside = (t: number): number => evalAnim(remap, t, numOps);
  const node = findNode(root, 'Box', 'RECTANGLE');
  assert.ok(node);
  follows(node, (t) => worldMatrix(node, root, t), (t) => mul(layerMatrix(main, pre, t), layerMatrix(inner, box, inside(t))), 100, 60, 3);
  const last = node.tracks.get('TRANSLATION_XY') ?? node.tracks.get('TRANSLATION_X');
  assert.ok(last && last[last.length - 1]!.timelinePosition <= 1.001, 'nothing moves once the composition is frozen');

  // In/out points are in the nested composition's time: 0.5-1.5 s there is 0.25-0.75 s here.
  const blinkNode = findNode(root, 'Blink', 'RECTANGLE');
  assert.ok(blinkNode);
  for (const [t, shown] of [[0.1, 0], [0.3, 1], [0.7, 1], [0.8, 0], [2.5, 0]] as Array<[number, number]>) {
    assert.equal(worldOpacity(blinkNode, root, t), shown, `Blink at t=${t}`);
  }

  // Frozen from the start (what an image-picker precomp does): only what shows at that moment is built.
  const frozen: Layer = { ...pre, content: { type: 'comp', compId: 'inner', width: 400, height: 300, startTime: 0, remap: { v: 1 } } };
  const still = build(docOf([compOf('main', [frozen], 3), inner]), false);
  assert.equal(still.out.motion.tracks, 0);
  assert.ok(findNode(still.root, 'Blink', 'RECTANGLE'), 'visible at the frozen moment');
  near(apply(worldMatrix(findNode(still.root, 'Box', 'RECTANGLE')!, still.root, 0), { x: 0, y: 0 }), apply(mul(layerMatrix(main, pre, 0), layerMatrix(inner, box, 1)), { x: 0, y: 0 }), 'Box at the frozen moment');
});

// --------------------------------------------------------------- track mattes

test('layers that share a track matte go into a frame with the matte as its mask', () => {
  const matte = solidLayer('3', 'Tab', 200, 100, { position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 2, v: { x: 300, y: 50 }, e: SNAP }]) }, { hidden: true });
  const a = solidLayer('1', 'Card A', 400, 300, { position: vec(10, 10) }, { matte: { layerId: '3' } });
  const b = solidLayer('2', 'Card B', 400, 300, { position: vec(40, 40) }, { matte: { layerId: '3' } });
  const bg = solidLayer('4', 'BG', 800, 600, {});
  const comp = compOf('main', [a, b, matte, bg], 2);
  const { root, out } = build(docOf([comp]), false);
  assert.deepEqual(out.motion.problems, []);

  const group = findNode(root, 'Tab (matte)', 'FRAME');
  assert.ok(group, 'one frame for both matted layers');
  assert.deepEqual(group.children.map((c) => c.name), ['Tab (mask)', 'Card B', 'Card A'], 'the mask is the lowest layer, the rest keep their order');
  const mask = group.children[0]!;
  assert.equal(mask.isMask, true);
  assert.equal(mask.maskType, 'ALPHA');
  follows(mask, (t) => worldMatrix(mask, root, t), (t) => layerMatrix(comp, matte, t), 200, 100, 2);
  assert.deepEqual(root.children.map((c) => c.name), ['BG', 'Tab (matte)'], 'the matte layer itself is not drawn');
  near(apply(worldMatrix(findNode(root, 'Card B', 'RECTANGLE')!, root, 1), { x: 0, y: 0 }), { x: 40, y: 40 }, 'Card B keeps its place');
});

// ------------------------------------------------------ components, variants

function logoDoc(): { doc: BridgeDoc; main: Comp; logo: Layer; markB: Layer; logoB: Comp } {
  const mark = (name: string, to: number): Layer =>
    solidLayer('1', name, 120, 80, { position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 1, v: { x: to, y: 30 }, e: SNAP }]) });
  const markB = mark('Mark B', 200);
  const logoA = compOf('logoA', [mark('Mark A', 100)], 2, 400, 300);
  const logoB = compOf('logoB', [markB], 2, 400, 300);
  const logo: Layer = {
    id: '1', name: 'Logo', inPoint: 0, outPoint: 3,
    transform: transform({ anchor: vec(200, 150), position: vecKeys([{ t: 0, v: { x: 400, y: 300 } }, { t: 2, v: { x: 500, y: 200 } }]) }),
    // Starts half a second in: the component's keys have to carry that delay.
    content: { type: 'comp', compId: 'logoB', width: 400, height: 300, startTime: 0.5, setId: 'setLogo' },
  };
  const main = compOf('main', [logo, solidLayer('2', 'BG', 800, 600, {})], 3);
  const doc = docOf([main, logoA, logoB]);
  doc.sets = {
    setLogo: {
      id: 'setLogo', name: 'Logo',
      props: [{ name: 'Brand', values: ['A', 'B'] }],
      variants: [{ compId: 'logoA', choice: [0] }, { compId: 'logoB', choice: [1] }],
    },
  };
  return { doc, main, logo, markB, logoB };
}

test('versions of a composition become a component set, and the layer an instance of the right variant', () => {
  const { doc, main, logo, markB, logoB } = logoDoc();
  const { root, page, out } = build(doc, true);
  assert.deepEqual(out.motion.problems, []);
  assert.deepEqual(out.warnings, []);

  const set = page.children.find((c) => c.type === 'COMPONENT_SET');
  assert.ok(set && set.name === 'Logo');
  assert.deepEqual(set.children.map((c) => `${c.type} ${c.name}`), ['COMPONENT Brand=A', 'COMPONENT Brand=B']);
  assert.deepEqual(out.components.map((c) => c.name), ['Logo']);

  const instance = findNode(root, 'Logo', 'INSTANCE');
  assert.ok(instance, 'the frame holds an instance, not the layers');
  assert.equal(instance.mainComponent?.name, 'Brand=B');
  assert.deepEqual(root.children.map((c) => c.type), ['RECTANGLE', 'INSTANCE'], 'the frame is as short as the After Effects timeline');

  // Inside the component the mark plays with the layer's half-second delay built in.
  const component = instance.mainComponent!;
  const node = findNode(component, 'Mark B', 'RECTANGLE');
  assert.ok(node);
  follows(
    node,
    (t) => mul(worldMatrix(instance, root, t), worldMatrix(node, component, t)),
    (t) => mul(layerMatrix(main, logo, t), layerMatrix(logoB, markB, t - 0.5)),
    120, 80, 3,
  );
  assert.ok(findNode(set.children[0]!, 'Mark A', 'RECTANGLE'), 'the other variant holds the other version');
});

test('with components switched off, or refused by Figma, the same picture is built into the frame', () => {
  for (const mode of ['off', 'refused'] as const) {
    const { doc, main, logo, markB, logoB } = logoDoc();
    const { root, page, out } = build(doc, mode === 'refused', (mock) => {
      mock.rejectComponents = true;
    });
    assert.deepEqual(page.children.map((c) => c.type), ['FRAME'], `${mode}: nothing but the frame is left on the page`);
    assert.equal(out.components.length, 0);
    assert.equal(out.warnings.some((w) => w.includes('could not be turned into a component')), mode === 'refused');
    const node = findNode(root, 'Mark B', 'RECTANGLE');
    assert.ok(node, `${mode}: the current version is in the frame`);
    assert.equal(findNode(root, 'Mark A', 'RECTANGLE'), undefined, `${mode}: the other version is left out`);
    follows(node, (t) => worldMatrix(node, root, t), (t) => mul(layerMatrix(main, logo, t), layerMatrix(logoB, markB, t - 0.5)), 120, 80, 3);
  }
});

// ------------------------------------------- reading options in After Effects

interface Host {
  listControllers(): string;
  beginExport(ids: string[]): string;
  exportState(index: number): string;
  endExport(): string;
}

function loadHost(): Host {
  vm.runInThisContext(readFileSync(new URL('../ae-panel/host/host.jsx', import.meta.url), 'utf8'), { filename: 'host.jsx' });
  return (globalThis as unknown as { MOTIONBRIDGE: Host }).MOTIONBRIDGE;
}

function menu(name: string, min: number, max: number, value: number): { effect: Group; prop: Prop } {
  const prop = new Prop('ADBE Dropdown Control-0001', PVT.OneD, value).range(min, max);
  prop.name = 'Menu';
  const effect = new Group('ADBE Dropdown Control', [prop], name);
  prop.parentProperty = effect;
  return { effect, prop };
}

function solid(comp: CompItem, name: string, id: number, opacity?: Prop): void {
  makeLayer(comp, name, 'ADBE AV Layer', [transformGroup(opacity ? { opacity } : {})], {
    source: new FootageItem(id, `${name} solid`, 100, 100, new SolidSource([1, 0.5, 0])), width: 100, height: 100,
  });
}

/** opacity = 100 when `control` is `value`, else 0 - the usual way a template switches layers. */
function shownWhen(control: Prop, text: string, value: number): Prop {
  return new Prop('ADBE Opacity', PVT.OneD, 100).expr(`${text} == ${value} ? 100 : 0`, () => (control.value === value ? 100 : 0));
}

function templateProject(): { main: CompItem; market: Prop; style: Prop } {
  // A nested badge with its own menu, exposed to the main composition as an Essential Property.
  const badge = new CompItem(20, 'Badge', 200, 200, 2);
  const style = menu('Style', 1, 3, 1);
  makeLayer(badge, 'BADGE CTRL', 'ADBE AV Layer', [transformGroup({}), new Group('ADBE Effect Parade', [style.effect])], { nullLayer: true });
  const styleText = 'thisComp.layer("BADGE CTRL").effect("Style")("Menu")';
  solid(badge, 'Round', 31, shownWhen(style.prop, styleText, 1));
  solid(badge, 'Square', 32, shownWhen(style.prop, styleText, 2));
  solid(badge, 'Star', 33, shownWhen(style.prop, styleText, 3));

  const main = new CompItem(10, 'Template', 800, 600, 2);
  main.time = 1;
  const market = menu('Market', 1, 3, 2);
  // A second menu nobody reads, and a checkbox worked out by an expression: neither is a template option.
  const unused = menu('Unused', 1, 4, 1);
  const derived = new Prop('ADBE Checkbox Control-0001', PVT.OneD, 0).range(0, 1, false).expr('effect("Market")("Menu") > 1', () => (market.prop.value as number) > 1 ? 1 : 0);
  derived.name = 'Checkbox';
  const derivedEffect = new Group('ADBE Checkbox Control', [derived], 'Wide');
  derived.parentProperty = derivedEffect;
  makeLayer(main, 'CTRL', 'ADBE Vector Layer', [transformGroup({}), new Group('ADBE Effect Parade', [market.effect, unused.effect, derivedEffect])], { guideLayer: true });

  const marketText = 'thisComp.layer("CTRL").effect("Market")("Menu")';
  solid(main, 'Logo A', 41, shownWhen(market.prop, marketText, 1));
  solid(main, 'Logo B', 42, shownWhen(market.prop, marketText, 2));
  solid(main, 'Logo C', 43, shownWhen(market.prop, marketText, 3));

  // The badge follows the market: market 1 -> style 2, anything else -> style 3.
  const over = new Prop('Pseudo/style-0001', PVT.OneD, 1).range(1, 3).expr(`${marketText} == 1 ? 2 : 3`, () => (market.prop.value === 1 ? 2 : 3));
  over.name = 'Style';
  over.essentialPropertySource = style.prop;
  makeLayer(main, 'Badge', 'ADBE AV Layer', [transformGroup({}), new Group('ADBE Layer Overrides', [over])], { source: badge, width: 200, height: 200 });
  solid(main, 'BG', 44);
  return { main, market: market.prop, style: style.prop };
}

function answer<T>(raw: string): T {
  const parsed = JSON.parse(raw) as HostResult<T>;
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.message} (line ${parsed.line})`);
  return parsed.data;
}

test('template options are found, read in every setting, and After Effects is left as it was', () => {
  const { main, market, style } = templateProject();
  installAeGlobals(main, new Map<number, unknown>([[20, undefined]]));
  const host = loadHost();

  const found = JSON.parse(host.listControllers()) as { controllers: RawController[] };
  assert.deepEqual(found.controllers.map((c) => [c.id, c.layer, c.name, c.min, c.max, c.value]), [['1.1.1', 'CTRL', 'Market', 1, 3, 2]], 'only the menu other layers read');

  const base = answer<RawDump>(host.beginExport(['1.1.1']));
  assert.deepEqual(base.pending, [[1], [3]], 'the two settings that are not the current one');
  assert.equal(style.value, 1, 'the nested menu is back at its own setting after the first read');
  const parts = [answer<RawState>(host.exportState(0)), answer<RawState>(host.exportState(1))];
  host.endExport();

  // Only layers that react to the option are read again (the control layer does: its checkbox is worked out from the menu).
  assert.deepEqual(parts[0]!.layers.map((l) => (l ? l.name : null)), ['CTRL', 'Logo A', 'Logo B', null, 'Badge', null]);
  assert.deepEqual(parts[1]!.layers.map((l) => (l ? l.name : null)), [null, null, 'Logo B', 'Logo C', null, null], 'the badge looks the same for market 2 and 3');

  assert.equal(market.value, 2, 'the option is back where the user left it');
  assert.equal(style.value, 1);
  assert.ok(undo.sets > 0, 'values really were switched in between');
  assert.equal(undo.stack.length, 0, 'and nothing of it is left in the undo list');

  const { doc } = convertAeDump(mergeDump(base, parts));
  const sets = Object.values(doc.sets ?? {});
  const badge = sets.find((s) => s.name === 'Badge');
  assert.deepEqual(badge?.props, [{ name: 'Style', values: ['Square', 'Star'] }], 'settings are named after the layer they show');
  const options = sets.find((s) => s.name === 'CTRL');
  assert.deepEqual(options?.props, [{ name: 'Market', values: ['Logo A', 'Logo B', 'Logo C'] }]);
  assert.equal(options?.variants.length, 3);

  const root = doc.comps[doc.rootCompId]!;
  assert.deepEqual(root.layers.map((l) => l.name), ['CTRL', 'BG'], 'everything that reacts to the option is one layer now');
  const holder = root.layers[0]!;
  assert.ok(holder.content.type === 'comp' && holder.content.setId === options?.id);
  const current = doc.comps[holder.content.compId]!;
  assert.deepEqual(current.layers.map((l) => l.name), ['Logo B', 'Badge']);

  const { root: frame, page, out } = build(doc, true);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(frame.children.map((c) => `${c.type} ${c.name}`), ['RECTANGLE BG', 'INSTANCE CTRL']);
  assert.equal(findNode(frame, 'CTRL', 'INSTANCE')?.mainComponent?.name, 'Market=Logo B');
  const marketSet = page.children.find((c) => c.type === 'COMPONENT_SET' && c.name === 'CTRL');
  assert.deepEqual(marketSet?.children.map((c) => c.name), ['Market=Logo A', 'Market=Logo B', 'Market=Logo C']);
  const first = marketSet!.children[0]!;
  assert.equal(findNode(first, 'Badge', 'INSTANCE')?.mainComponent?.name, 'Style=Square', 'a variant shows the nested version that goes with it');
});

test('without options ticked, a nested composition is still read with the values its layer gives it', () => {
  const { main, market, style } = templateProject();
  installAeGlobals(main);
  const host = loadHost();
  const base = answer<RawDump>(host.beginExport([]));
  assert.deepEqual(base.pending, []);
  assert.equal(style.value, 1);
  assert.equal(market.value, 2);
  assert.equal(undo.stack.length, 0);

  const { doc } = convertAeDump(base);
  assert.equal(doc.sets, undefined, 'one version of everything: no sets');
  const root = doc.comps[doc.rootCompId]!;
  assert.deepEqual(root.layers.map((l) => l.name), ['Logo B', 'Badge', 'BG'], 'layers held at zero opacity are left out');
  const badge = root.layers[1]!;
  assert.ok(badge.content.type === 'comp');
  assert.deepEqual(doc.comps[badge.content.compId]!.layers.map((l) => l.name), ['Star'], 'style 3, although the nested composition itself is set to 1');
});
