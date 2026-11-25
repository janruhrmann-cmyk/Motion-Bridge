/**
 * Figma -> After Effects: plans a document (shared/ae-build.ts), lets the real
 * host.jsx build the plan in a stand-in project, reads the result back with
 * the same script and checks that it is the document it started from - same
 * corners, same opacity, same colours at every sampled time.
 *
 * (The stand-in checks the script's logic. That After Effects itself takes
 * the plan the same way was checked against After Effects 2027: the
 * composition it built read back as the same motion.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { HostResult, RawDump } from '../shared/ae-raw.ts';
import { planBuild, planText } from '../shared/ae-build.ts';
import type { BuildPlan, PlanKey, PlanLayer, PlanProp } from '../shared/ae-build.ts';
import { convertAeDump } from '../shared/ae-convert.ts';
import { easeProgress, evalAnim, evalAnimVec, numOps, rgbaOps } from '../shared/anim.ts';
import type { BridgeDoc, Comp, Content, Ease, Layer, Rect, RGBA, Transform } from '../shared/format.ts';
import { ellipseSubPath, pathsBounds, reversed } from '../shared/geometry.ts';
import { CompItem, installAeProject } from './mock-ae.ts';
import type { MockLayer, MockProject, Prop } from './mock-ae.ts';
import { apply, layerMatrix, transform as tr, vec } from './sim.ts';

interface Built {
  id: string;
  name: string;
  comps: number;
  layers: number;
  keys: number;
  images: number;
  warnings: Array<{ comp?: string; layer?: string; message: string }>;
}

interface Host {
  buildFromFile(path: string, open: boolean): string;
  buildDefaults(): string;
  footageFolder(): string;
  beginExport(ids: string[], compId?: string, poster?: number | null): string;
  endExport(): string;
  getStatus(): string;
}

function loadHost(): Host {
  vm.runInThisContext(readFileSync(new URL('../ae-panel/host/host.jsx', import.meta.url), 'utf8'), { filename: 'host.jsx' });
  return (globalThis as unknown as { MOTIONBRIDGE: Host }).MOTIONBRIDGE;
}

const EASE: Ease = { type: 'bezier', x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
const OVERSHOOT: Ease = { type: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
/** Handles that reach so far that half of this ease cannot be written as an ease of its own. */
const SNAP: Ease = { type: 'bezier', x1: 0.78, y1: 0, x2: 0, y2: 1 };
const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
const PLAN_FILE = 'C:/temp/plan.json';
const IMAGE_FILE = 'C:/temp/ramp.png';
const OPTIONS = { frameRate: 25, duration: 6, files: { img1: IMAGE_FILE } };

function layer(id: string, name: string, content: Content, over: Partial<Transform> = {}, extra: Partial<Layer> = {}): Layer {
  return { id, name, transform: tr(over), content, inPoint: 0, outPoint: 3, ...extra };
}

function docOf(comps: Comp[], assets: BridgeDoc['assets'] = {}): BridgeDoc {
  const map: Record<string, Comp> = {};
  for (const c of comps) map[c.id] = c;
  return { format: 'motion-bridge', version: 3, source: { app: 'figma', version: 'test' }, rootCompId: comps[0]!.id, posterTime: 0, comps: map, assets, warnings: [] };
}

function comp(id: string, name: string, layers: Layer[], timing: { duration: number; frameRate: number } = { duration: 3, frameRate: 30 }, w = 800, h = 600): Comp {
  return { id, name, width: w, height: h, ...timing, background: rgba(0.9, 0.9, 0.9), layers };
}

/** A frame with a bit of everything: the same one that was built in After Effects 2027. */
function sampleDoc(): BridgeDoc {
  const card = comp(
    'inner',
    'Card',
    [
      layer('i1', 'Dot', { type: 'ellipse', size: vec(60, 60), style: { fills: [{ color: { v: rgba(1, 1, 1) } }], strokes: [] } }, {
        position: { mode: 'vec', a: { v: { x: 40, y: 100 }, k: [{ t: 0.2, v: { x: -40, y: 100 } }, { t: 1.2, v: { x: 340, y: 100 }, e: EASE }] } },
      }),
      layer('i2', 'Card background', { type: 'rect', size: vec(300, 200), radius: { v: 0 }, style: { fills: [{ color: { v: rgba(0.1, 0.4, 0.9) } }], strokes: [] } }, { position: vec(150, 100) }),
    ],
    { duration: 0, frameRate: 0 },
    300,
    200,
  );
  const root = comp('root', 'Frame', [
    layer(
      'L1',
      'Headline',
      { type: 'text', text: 'Hello Figma', fontFamily: 'Arial', fontStyle: 'Bold', fontSize: 48, fill: rgba(0.1, 0.1, 0.1), align: 'left', tracking: 0, lineHeight: 56, firstBaseline: { x: 0, y: 44 } },
      { position: vec(40, 40), opacity: { v: 1, k: [{ t: 0, v: 0 }, { t: 0.5, v: 1, e: EASE }] } },
    ),
    layer(
      'L2',
      'Body copy',
      { type: 'text', text: 'A paragraph in a box,\nwith a second line.', fontFamily: 'Arial', fontStyle: 'Regular', fontSize: 20, fill: rgba(0.3, 0.3, 0.3), align: 'left', tracking: 20, lineHeight: 26, firstBaseline: { x: 0, y: 16 }, box: { x: 0, y: 0, w: 260, h: 90 } },
      { position: vec(40, 110) },
    ),
    layer('L3', 'Orbit dot', { type: 'ellipse', size: vec(30, 30), style: { fills: [{ color: { v: rgba(0.1, 0.1, 0.1) } }], strokes: [] } }, { position: vec(80, -50) }, { parentId: 'L4' }),
    layer(
      'L4',
      'Promo tab',
      {
        type: 'rect',
        size: { mode: 'vec', a: { v: { x: 160, y: 100 }, k: [{ t: 0, v: { x: 160, y: 100 } }, { t: 1, v: { x: 200, y: 100 }, e: EASE }] } },
        radius: { v: 20 },
        style: {
          fills: [{ color: { v: rgba(1, 0.5, 0), k: [{ t: 0, v: rgba(1, 0.5, 0) }, { t: 2, v: rgba(0.9, 0.1, 0.3), e: EASE }] } }],
          strokes: [{ color: { v: rgba(0.1, 0.1, 0.1) } }],
          strokeWidth: { v: 4 },
          join: 'round',
        },
      },
      {
        position: { mode: 'vec', a: { v: { x: 200, y: 400 }, k: [{ t: 0, v: { x: 200, y: 400 } }, { t: 1, v: { x: 600, y: 400 }, e: SNAP }, { t: 2, v: { x: 600, y: 250 }, e: EASE }] } },
        rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 90, e: OVERSHOOT }, { t: 1.5, v: 90, e: { type: 'hold' } }, { t: 2.5, v: 0 }] },
        // Each axis has keys of its own; After Effects has one set of keys for both.
        scale: { mode: 'split', x: { v: 1, k: [{ t: 0, v: 0.5 }, { t: 1, v: 1, e: EASE }] }, y: { v: 1, k: [{ t: 0.5, v: 0.5 }, { t: 1.5, v: 1, e: SNAP }] } },
      },
      { shadow: { color: rgba(0, 0, 0, 0.35), offset: { x: 0, y: 8 }, blur: 12 } },
    ),
    layer('L5', 'Ring', { type: 'path', paths: [ellipseSubPath(60, 60, 120, 120), reversed(ellipseSubPath(60, 60, 60, 60))], style: { fills: [{ color: { v: rgba(0.2, 0.7, 0.4, 0.8) } }], strokes: [], fillRule: 'evenodd' } }, { anchor: vec(60, 60), position: vec(650, 120) }, { blendMode: 'multiply' }),
    layer(
      'L6',
      'Line',
      {
        type: 'path',
        paths: [{ closed: false, v: [{ x: 0, y: 0 }, { x: 150, y: 60 }, { x: 300, y: 0 }], i: [{ x: 0, y: 0 }, { x: -50, y: 0 }, { x: 0, y: 0 }], o: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0 }] }],
        style: {
          fills: [],
          strokes: [{ color: { v: rgba(0.5, 0.1, 0.8) } }],
          strokeWidth: { v: 6 },
          cap: 'round',
          dashes: [20, 10],
          trim: { start: { v: 0 }, end: { v: 1, k: [{ t: 0, v: 0 }, { t: 1.5, v: 1, e: EASE }] }, offset: { v: 0 } },
        },
      },
      { position: vec(420, 180) },
    ),
    layer('L7', 'Card', { type: 'comp', compId: 'inner', width: 300, height: 200, startTime: 0 }, { anchor: vec(150, 100), position: vec(200, 300), rotation: { v: -8 } }, { matte: { layerId: 'L8' } }),
    layer('L8', 'Card clip', { type: 'rect', size: vec(300, 200), radius: { v: 40 }, style: { fills: [{ color: { v: rgba(1, 1, 1) } }], strokes: [] } }, { position: vec(150, 100) }, { parentId: 'L7', hidden: true }),
    // The picture has 64 x 32 pixels and covers 128 x 64 here.
    layer('L9', 'Picture', { type: 'image', width: 128, height: 64, assetId: 'img1' }, { anchor: vec(64, 32), position: vec(650, 480) }),
    layer('L11', 'Backdrop', { type: 'solid', width: 800, height: 100, color: rgba(0.85, 0.85, 0.8) }, { position: vec(0, 500) }),
  ]);
  return docOf([root, card], { img1: { id: 'img1', name: 'Ramp', width: 64, height: 32, mime: 'image/png' } });
}

function build(doc: BridgeDoc): { project: MockProject; host: Host; plan: BuildPlan; built: Built; made: CompItem } {
  const { plan, warnings } = planBuild(doc, OPTIONS);
  assert.deepEqual(warnings, [], 'nothing in this document should need a note');
  const project = installAeProject(new Map([[PLAN_FILE, planText(plan)], [IMAGE_FILE, 'png']]));
  const host = loadHost();
  const answer = JSON.parse(host.buildFromFile(PLAN_FILE, false)) as HostResult<Built>;
  if (!answer.ok) throw new Error(`${answer.message} (host.jsx line ${answer.line})`);
  const made = project.items.find((it) => it instanceof CompItem && String(it.id) === answer.data.id) as CompItem;
  return { project, host, plan, built: answer.data, made };
}

function readBack(host: Host, id: string): BridgeDoc {
  const answer = JSON.parse(host.beginExport([], id, 0)) as HostResult<RawDump>;
  host.endExport();
  if (!answer.ok) throw new Error(`${answer.message} (host.jsx line ${answer.line})`);
  return convertAeDump(answer.data).doc;
}

/** The content a layer draws, whatever wrapping the way back added (a shape layer comes back as a group of one). */
function drawn(content: Content): Content {
  let c = content;
  while (c.type === 'group' && c.children.length === 1) c = c.children[0]!.content;
  return c;
}

function boxOf(content: Content): Rect | null {
  switch (content.type) {
    case 'rect':
    case 'ellipse': {
      const s = evalAnimVec(content.size, 0);
      return { x: -s.x / 2, y: -s.y / 2, w: s.x, h: s.y };
    }
    case 'path':
      return pathsBounds(content.paths);
    case 'solid':
    case 'image':
    case 'comp':
      return { x: 0, y: 0, w: content.width, h: content.height };
    default:
      return null;
  }
}

function assertSameMotion(want: Comp, got: Comp, duration: number): void {
  for (const a of want.layers) {
    const b = got.layers.find((l) => l.name === a.name);
    assert.ok(b, `"${a.name}" was built and read back`);
    const ca = drawn(a.content);
    const cb = drawn(b.content);
    assert.equal(cb.type, ca.type, `"${a.name}" is a ${ca.type}`);
    for (let t = 0; t <= duration + 1e-9; t += 0.05) {
      const at = `"${a.name}" at ${t.toFixed(2)} s`;
      assert.ok(Math.abs(evalAnim(a.transform.opacity, t, numOps) - evalAnim(b.transform.opacity, t, numOps)) < 0.005, `${at}: opacity`);
      // Text is measured from its baseline in After Effects and from the document's point here: compare where that point ends up.
      const points = ca.type === 'text' && cb.type === 'text' ? [[ca.firstBaseline], [cb.firstBaseline]] : [boxOf(ca), boxOf(cb)].map((r) => (r ? [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }] : []));
      const ma = layerMatrix(want, a, t);
      const mb = layerMatrix(got, b, t);
      points[0]!.forEach((p, i) => {
        const pa = apply(ma, p);
        const pb = apply(mb, points[1]![i]!);
        assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) < 0.25, `${at}: corner ${i} is at (${pb.x.toFixed(2)}, ${pb.y.toFixed(2)}), expected (${pa.x.toFixed(2)}, ${pa.y.toFixed(2)})`);
      });
      if ((ca.type === 'rect' || ca.type === 'ellipse') && cb.type === ca.type) {
        const sa = evalAnimVec(ca.size, t);
        const sb = evalAnimVec(cb.size, t);
        assert.ok(Math.hypot(sa.x - sb.x, sa.y - sb.y) < 0.1, `${at}: size`);
        const fa = ca.style.fills[0];
        const fb = cb.style.fills[0];
        if (fa) assert.ok(fb && rgbaOps.dist(evalAnim(fa.color, t, rgbaOps), evalAnim(fb.color, t, rgbaOps)) < 0.01, `${at}: fill colour`);
      }
      if (ca.type === 'path' && cb.type === 'path' && ca.style.trim) {
        assert.ok(cb.style.trim, `"${a.name}" keeps its trim`);
        assert.ok(Math.abs(evalAnim(ca.style.trim.end, t, numOps) - evalAnim(cb.style.trim.end, t, numOps)) < 0.005, `${at}: trim end`);
      }
    }
    assert.equal(b.parentId !== undefined, a.parentId !== undefined, `"${a.name}": parenting`);
    assert.equal(!!b.matte, !!a.matte, `"${a.name}": track matte`);
    assert.equal(b.blendMode ?? 'normal', a.blendMode ?? 'normal', `"${a.name}": blend mode`);
    assert.deepEqual(b.shadow, a.shadow, `"${a.name}": shadow`);
  }
}

test('a frame built in After Effects reads back as the same picture and the same motion', () => {
  const doc = sampleDoc();
  const { host, built, made, project } = build(doc);
  assert.equal(built.name, 'Frame');
  assert.equal(built.comps, 2);
  assert.equal(built.layers, 12);
  assert.equal(built.images, 1);
  assert.deepEqual(built.warnings, []);
  // Front-most first, as in the document.
  assert.deepEqual(made.layers.map((l) => l.name), doc.comps.root!.layers.map((l) => l.name));
  assert.equal(made.frameRate, 30);
  assert.equal(made.duration, 3);

  const back = readBack(host, built.id);
  assertSameMotion(doc.comps.root!, back.comps[back.rootCompId]!, 3);
  const card = Object.values(back.comps).find((c) => c.name === 'Card');
  assert.ok(card, 'the nested composition was built and read back');
  assertSameMotion(doc.comps.inner!, card, 3);

  // A frame without timing of its own takes the root's: the card has no length in the document.
  const nested = project.items.find((it) => it instanceof CompItem && it.name === 'Card') as CompItem;
  assert.equal(nested.duration, 3);
  assert.equal(nested.frameRate, 30);
  // The composition stays where compositions are made; what it is built from goes into a folder of its own.
  assert.equal((nested.parentFolder as { name: string }).name, 'Frame (Figma)');
  assert.equal(made.parentFolder, null);
  assert.deepEqual(project.undoNames, ['Motion Bridge: build "Frame"'], 'the whole build is one undo step');
});

test('what the frame is made of arrives as the right kind of layer', () => {
  const { made } = build(sampleDoc());
  const byName = (name: string): MockLayer => made.layers.find((l) => l.name === name)!;
  assert.equal(byName('Headline').matchName, 'ADBE Text Layer');
  assert.equal(byName('Promo tab').matchName, 'ADBE Vector Layer');
  assert.ok(byName('Card').source instanceof CompItem);
  assert.equal(byName('Orbit dot').parent, byName('Promo tab'));
  assert.equal(byName('Card').trackMatteLayer, byName('Card clip'));
  assert.equal(byName('Card clip').enabled, false, 'a matte is not drawn itself');
  assert.equal(byName('Ring').blendingMode, 'MULTIPLY');

  // The picture is counted in its own pixels: half the size here, so twice the scale and half the anchor.
  const picture = byName('Picture').property('ADBE Transform Group')!;
  assert.deepEqual((picture.property('ADBE Scale') as Prop).value, [200, 200]);
  assert.deepEqual((picture.property('ADBE Anchor Point') as Prop).value, [32, 16]);

  // Position keys run in straight lines, not on the curve After Effects would draw through them.
  const position = byName('Promo tab').property('ADBE Transform Group')!.property('ADBE Position') as Prop;
  assert.equal(position.keys.length, 3);
  for (const k of position.keys) {
    assert.deepEqual(k.inTan, [0, 0, 0]);
    assert.equal((k as { autoBezier?: boolean }).autoBezier, false);
  }
});

test('an ease is written as the speed and influence After Effects keeps', () => {
  const doc = docOf([
    comp('root', 'Frame', [
      layer('a', 'Mover', { type: 'solid', width: 10, height: 10, color: rgba(1, 0, 0) }, {
        position: { mode: 'vec', a: { v: { x: 0, y: 0 }, k: [{ t: 0, v: { x: 0, y: 0 } }, { t: 2, v: { x: 300, y: 400 }, e: OVERSHOOT }, { t: 3, v: { x: 300, y: 400 }, e: { type: 'hold' } }] } },
        rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 90 }, { t: 2, v: 0, e: { type: 'bezier', x1: 0, y1: 0, x2: 0.5, y2: 1 } }] },
      }),
    ]),
  ]);
  const planned = planBuild(doc, OPTIONS).plan.comps[0]!.layers[0]!;
  const prop = (l: PlanLayer, mn: string): PlanProp => l.tr.find((s) => s[0] === mn)![1];
  const keys = (l: PlanLayer, mn: string): PlanKey[] => prop(l, mn).k!;

  // 500 px in 2 s: a position eases along its path, with one ease for both axes.
  const [p0, p1, p2] = keys(planned, 'ADBE Position') as [PlanKey, PlanKey, PlanKey];
  assert.equal(p0.oi, 'b');
  assert.equal(p0.oe.length, 1);
  assert.ok(Math.abs(p0.oe[0]!.i - 34) < 1e-6);
  assert.ok(Math.abs(p0.oe[0]!.s - (250 * 1.56) / 0.34) < 1e-3, `out speed ${p0.oe[0]!.s}`);
  assert.equal(p1.ii, 'b');
  assert.ok(Math.abs(p1.ie[0]!.i - 36) < 1e-6);
  assert.ok(Math.abs(p1.ie[0]!.s) < 1e-6, 'it arrives flat');
  assert.equal(p1.oi, 'h', 'a hold is the out side of the key before it');
  assert.equal(p2.ii, 'l');

  // A plain step is linear on both sides; a handle lying on the corner of the box is a linear side too.
  const [r0, r1, r2] = keys(planned, 'ADBE Rotate Z') as [PlanKey, PlanKey, PlanKey];
  assert.deepEqual([r0.oi, r1.ii], ['l', 'l']);
  assert.deepEqual([r1.oi, r2.ii], ['l', 'b']);
  assert.ok(Math.abs(r2.ie[0]!.i - 50) < 1e-6);
});

test('a spring becomes eased steps that follow its curve', () => {
  const spring: Ease = { type: 'spring', bounce: 0.6 };
  const doc = docOf([
    comp('root', 'Frame', [layer('a', 'Bouncer', { type: 'solid', width: 10, height: 10, color: rgba(1, 0, 0) }, { rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 100, e: spring }] } })]),
  ]);
  const { host, built } = build(doc);
  const back = readBack(host, built.id);
  const rotation = back.comps[back.rootCompId]!.layers[0]!.transform.rotation;
  assert.ok(rotation.k && rotation.k.length > 2, 'more than the two keys it started with');
  assert.ok(rotation.k.every((k) => !k.e || k.e.type !== 'spring'));
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const want = 100 * easeProgress(spring, t);
    assert.ok(Math.abs(evalAnim(rotation, t, numOps) - want) < 1.5, `at ${t.toFixed(2)} s: ${evalAnim(rotation, t, numOps).toFixed(2)} for ${want.toFixed(2)}`);
  }
});

test('a still frame gets the timing After Effects is asked to give it', () => {
  const doc = docOf([comp('root', 'Still', [layer('a', 'Box', { type: 'solid', width: 10, height: 10, color: rgba(1, 0, 0) })], { duration: 0, frameRate: 0 }, 1080.4, 1349.6)]);
  const { made } = build(doc);
  assert.equal(made.frameRate, 25);
  assert.equal(made.duration, 6);
  // Composition sizes are whole pixels.
  assert.deepEqual([made.width, made.height], [1080, 1350]);
  assert.deepEqual([made.layers[0]!.inPoint, made.layers[0]!.outPoint], [0, 6], 'the layer is there for all of it');
});

test('four different corners become a path, and a missing image a grey solid', () => {
  const doc = docOf([
    comp('root', 'Frame', [
      layer('a', 'Tab', { type: 'rect', size: vec(100, 50), radius: { v: 0 }, radii: [{ v: 10 }, { v: 0 }, { v: 20 }, { v: 5 }], style: { fills: [{ color: { v: rgba(1, 0, 0) } }], strokes: [] } }),
      layer('b', 'Photo', { type: 'image', width: 40, height: 30, assetId: 'gone' }),
    ]),
  ]);
  const { plan, warnings } = planBuild(doc, OPTIONS);
  const [tab, photo] = plan.comps[0]!.layers as [PlanLayer, PlanLayer];
  const items = tab.shape![0]!.items!;
  assert.equal(items[0]!.mn, 'ADBE Vector Shape - Group');
  // Three rounded corners with two points each, one sharp one.
  assert.equal(items[0]!.path!.v.length, 7);
  assert.equal(photo.type, 'solid');
  assert.deepEqual(photo.solid, { w: 40, h: 30, color: [0.5, 0.5, 0.5] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /could not be transferred/);
});

test('the plan is plain ASCII, whatever the layers are called', () => {
  const doc = docOf([comp('root', 'Größe \u2028 日本', [layer('a', 'Ünïcode "quoted"', { type: 'solid', width: 10, height: 10, color: rgba(1, 0, 0) })])]);
  const text = planText(planBuild(doc, OPTIONS).plan);
  assert.ok(/^[\x20-\x7e]*$/.test(text), 'only printable ASCII');
  const { made } = build(doc);
  assert.equal(made.name, 'Größe \u2028 日本');
  assert.equal(made.layers[0]!.name, 'Ünïcode "quoted"');
});

test('a build that cannot be finished says why and leaves no undo step open', () => {
  const doc = sampleDoc();
  const { plan } = planBuild(doc, OPTIONS);
  // The image is not on disk.
  const project = installAeProject(new Map([[PLAN_FILE, planText(plan)]]));
  const host = loadHost();
  const answer = JSON.parse(host.buildFromFile(PLAN_FILE, false)) as HostResult<Built>;
  assert.equal(answer.ok, false);
  assert.match((answer as { message: string }).message, /Ramp/);
  assert.equal(project.items.filter((it) => it instanceof CompItem).length, 0, 'nothing was built');
});

test('new compositions take their settings from the open one, else from what the project uses most', () => {
  const project = installAeProject();
  const host = loadHost();
  assert.deepEqual(JSON.parse(host.buildDefaults()), { ok: true, frameRate: 30, duration: 5 });
  const items = (globalThis as unknown as { app: { project: { items: { addComp(...args: unknown[]): CompItem }; activeItem: unknown } } }).app.project;
  items.items.addComp('a', 100, 100, 1, 6, 25);
  items.items.addComp('b', 100, 100, 1, 6, 25);
  const other = items.items.addComp('c', 100, 100, 1, 10, 24);
  assert.deepEqual(JSON.parse(host.buildDefaults()), { ok: true, frameRate: 25, duration: 6 });
  items.activeItem = other;
  assert.deepEqual(JSON.parse(host.buildDefaults()), { ok: true, frameRate: 24, duration: 10 });
  assert.equal(project.items.length, 3);
  assert.deepEqual(JSON.parse(host.footageFolder()), { ok: true, path: 'C:/Users/test/Documents/Motion Bridge Footage' });
});
