/**
 * Runs the real After Effects script (host.jsx) against a stand-in project,
 * converts what it returns and builds the result in the mock Figma: the whole
 * pipeline, minus the two applications themselves.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { HostResult, RawDump } from '../shared/ae-raw.ts';
import { convertAeDump } from '../shared/ae-convert.ts';
import { evalAnim, numOps } from '../shared/anim.ts';
import { buildDocument } from '../figma-plugin/src/build/builder.ts';
import { CompItem, FileSource, FootageItem, Group, KIT, Prop, PVT, SolidSource, installAeGlobals, makeLayer, transformGroup } from './mock-ae.ts';
import type { Mat, MockNode } from './sim.ts';
import { apply, chain, findNode, installMockFigma, layerMatrix, mul, nodeSize, rotateMat, translate, worldMatrix } from './sim.ts';

interface Host {
  exportActiveComp(): string;
  getStatus(): string;
  beginExport(ids: string[], compId?: string, poster?: number | null): string;
  endExport(): string;
}

function loadHost(): Host {
  vm.runInThisContext(readFileSync(new URL('../ae-panel/host/host.jsx', import.meta.url), 'utf8'), { filename: 'host.jsx' });
  return (globalThis as unknown as { MOTIONBRIDGE: Host }).MOTIONBRIDGE;
}

const LINEAR = { inType: KIT.LINEAR, outType: KIT.LINEAR };

function project(): CompItem {
  const inner = new CompItem(20, 'Inner', 400, 300, 2);
  makeLayer(
    inner,
    'InnerBox',
    'ADBE AV Layer',
    [
      transformGroup({
        anchor: new Prop('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [50, 50, 0]),
        position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [50, 50, 0], [
          { time: 0, value: [50, 50, 0] },
          { time: 1, value: [350, 250, 0] },
        ]),
      }),
    ],
    { source: new FootageItem(30, 'Red Solid 1', 100, 100, new SolidSource([1, 0, 0])), width: 100, height: 100 },
  );

  const main = new CompItem(10, 'Main "Ä" 日本', 800, 600, 3);
  main.time = 1;

  const ctrl = makeLayer(
    main,
    'CTRL',
    'ADBE AV Layer',
    [
      transformGroup({
        position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [100, 100, 0], [
          { time: 0, value: [100, 100, 0] },
          { time: 1, value: [300, 100, 0] },
        ]),
        rotation: new Prop('ADBE Rotate Z', PVT.OneD, 0, [
          { time: 0, value: 0, ...LINEAR, inEase: [{ speed: 45, influence: 16.667 }], outEase: [{ speed: 45, influence: 16.667 }] },
          { time: 2, value: 90, ...LINEAR, inEase: [{ speed: 45, influence: 16.667 }], outEase: [{ speed: 45, influence: 16.667 }] },
        ]),
      }),
    ],
    { nullLayer: true, source: new FootageItem(31, 'Null 1', 100, 100, new SolidSource([1, 1, 1])), width: 100, height: 100 },
  );

  const easy2 = [{ speed: 0, influence: 33.33333 }, { speed: 0, influence: 33.33333 }];
  const box = makeLayer(main, 'Box', 'ADBE Vector Layer', [
    transformGroup({
      position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [50, 0, 0]),
      opacity: new Prop('ADBE Opacity', PVT.OneD, 100, [
        { time: 0, value: 0 },
        { time: 0.5, value: 100 },
      ]),
    }),
    new Group('ADBE Root Vectors Group', [
      new Group(
        'ADBE Vector Group',
        [
          new Group('ADBE Vectors Group', [
            new Group(
              'ADBE Vector Shape - Rect',
              [
                new Prop('ADBE Vector Rect Size', PVT.TwoD, [100, 60], [
                  { time: 0, value: [100, 60], inEase: easy2, outEase: easy2 },
                  { time: 1, value: [200, 60], inEase: easy2, outEase: easy2 },
                ]),
                new Prop('ADBE Vector Rect Position', PVT.TwoD_SPATIAL, [0, 0]),
                new Prop('ADBE Vector Rect Roundness', PVT.OneD, 8),
              ],
              'Rectangle Path 1',
            ),
            new Group(
              'ADBE Vector Graphic - Stroke',
              [
                new Prop('ADBE Vector Stroke Color', PVT.COLOR, [0, 0, 1, 1]),
                new Prop('ADBE Vector Stroke Opacity', PVT.OneD, 100),
                new Prop('ADBE Vector Stroke Width', PVT.OneD, 4),
                new Prop('ADBE Vector Stroke Line Cap', PVT.OneD, 2),
                new Prop('ADBE Vector Stroke Line Join', PVT.OneD, 1),
                new Prop('ADBE Vector Stroke Miter Limit', PVT.OneD, 4),
              ],
              'Stroke 1',
            ),
            new Group(
              'ADBE Vector Graphic - Fill',
              [
                new Prop('ADBE Vector Fill Color', PVT.COLOR, [1, 0, 0, 1]),
                new Prop('ADBE Vector Fill Opacity', PVT.OneD, 50),
                new Prop('ADBE Vector Fill Rule', PVT.OneD, 1),
              ],
              'Fill 1',
            ),
          ]),
          new Group('ADBE Vector Transform Group', [
            new Prop('ADBE Vector Anchor', PVT.TwoD_SPATIAL, [0, 0]),
            new Prop('ADBE Vector Position', PVT.TwoD_SPATIAL, [0, 0]),
            new Prop('ADBE Vector Scale', PVT.TwoD, [100, 100]),
            new Prop('ADBE Vector Skew', PVT.OneD, 0),
            new Prop('ADBE Vector Rotation', PVT.OneD, 0),
            new Prop('ADBE Vector Group Opacity', PVT.OneD, 100),
          ]),
        ],
        'Rectangle 1',
      ),
    ]),
  ]);
  box.parent = ctrl;

  const title = makeLayer(
    main,
    'Title',
    'ADBE Text Layer',
    [
      transformGroup({ position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [0, 120, 0]) }),
      new Group('ADBE Text Properties', [
        new Prop('ADBE Text Document', PVT.TEXT_DOCUMENT, {
          text: 'Hello\rWorld',
          font: 'Inter-Bold',
          fontFamily: 'Inter',
          fontStyle: 'Bold',
          fontSize: 40,
          applyFill: true,
          fillColor: [1, 1, 1],
          applyStroke: false,
          justification: 'CENTER_JUSTIFY',
          tracking: 50,
          leading: 48,
          boxText: false,
          baselineLocs: [-60, 0, 60, 0, -55, 48, 55, 48],
        }),
        new Group('ADBE Text Animators', []),
      ]),
    ],
    { inPoint: 0.5, outPoint: 1.5 },
  );
  title.parent = ctrl;

  makeLayer(
    main,
    'Curve',
    'ADBE AV Layer',
    [
      transformGroup({
        anchor: new Prop('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [25, 25, 0]),
        position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [100, 500, 0], [
          { time: 0, value: [100, 500, 0], outTan: [0, -200, 0] },
          { time: 2, value: [700, 500, 0], inTan: [0, -200, 0] },
        ]),
      }),
    ],
    { source: new FootageItem(32, 'Blue Solid 1', 50, 50, new SolidSource([0, 0, 1])), width: 50, height: 50 },
  );

  makeLayer(
    main,
    'BG',
    'ADBE AV Layer',
    [
      transformGroup({
        anchor: new Prop('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [400, 300, 0]),
        position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [400, 300, 0]),
        scale: new Prop('ADBE Scale', PVT.ThreeD, [50, 50, 100]),
      }),
      new Group('ADBE Effect Parade', [new Group('ADBE Gaussian Blur 2', [], 'Gaussian Blur')]),
    ],
    { source: new FootageItem(33, 'Grey Solid 1', 800, 600, new SolidSource([0.5, 0.5, 0.5])), width: 800, height: 600, blendingMode: 'MULTIPLY' },
  );

  makeLayer(
    main,
    'Inner',
    'ADBE AV Layer',
    [
      transformGroup({
        anchor: new Prop('ADBE Anchor Point', PVT.ThreeD_SPATIAL, [200, 150, 0]),
        position: new Prop('ADBE Position', PVT.ThreeD_SPATIAL, [400, 300, 0]),
      }),
    ],
    { source: inner, width: 400, height: 300, startTime: 0.5, inPoint: 0.5, outPoint: 2.5 },
  );

  makeLayer(main, 'Camera 1', 'ADBE Camera Layer', []);

  makeLayer(main, 'photo.png', 'ADBE AV Layer', [transformGroup({})], {
    source: new FootageItem(34, 'photo.png', 640, 480, new FileSource('C:/footage/photo.png', true)),
    width: 640,
    height: 480,
  });

  makeLayer(main, 'Hidden', 'ADBE AV Layer', [transformGroup({})], {
    enabled: false,
    source: new FootageItem(35, 'Black Solid 1', 10, 10, new SolidSource([0, 0, 0])),
    width: 10,
    height: 10,
  });
  return main;
}

test('host.jsx reads a composition and the result converts and builds', () => {
  const main = project();
  installAeGlobals(main);
  const host = loadHost();

  const status = JSON.parse(host.getStatus()) as { ok: boolean; comp: { name: string; layers: number } };
  assert.equal(status.comp.name, 'Main "Ä" 日本', 'names survive the hand-written JSON encoder');
  assert.equal(status.comp.layers, 9);

  const raw = host.exportActiveComp();
  assert.ok(/^[\x20-\x7e]*$/.test(raw), 'the script only returns plain ASCII');
  const result = JSON.parse(raw) as HostResult<RawDump>;
  assert.ok(result.ok, result.ok ? '' : `${result.message} (line ${result.line})`);
  const dump = result.data;
  assert.deepEqual(dump.warnings, []);
  assert.equal(dump.poster, 1);

  const { doc, assets } = convertAeDump(dump);
  const comp = doc.comps[doc.rootCompId]!;
  assert.equal(comp.name, 'Main "Ä" 日本');
  assert.deepEqual(comp.layers.map((l) => l.name), ['CTRL', 'Box', 'Title', 'Curve', 'BG', 'Inner', 'photo.png']);
  assert.ok(doc.comps['20'], 'the nested composition comes along');

  // Easy ease becomes the familiar 33 % bezier; linear keys stay linear.
  const ctrl = comp.layers[0]!;
  assert.equal(ctrl.hidden, true);
  assert.ok(ctrl.transform.position.mode === 'vec');
  assert.deepEqual(ctrl.transform.position.a.k, [
    { t: 0, v: { x: 100, y: 100 } },
    { t: 1, v: { x: 300, y: 100 }, e: { type: 'bezier', x1: 0.3333, y1: 0, x2: 0.6667, y2: 1 } },
  ]);
  assert.deepEqual(ctrl.transform.rotation.k, [{ t: 0, v: 0 }, { t: 2, v: 90 }]);

  // Shape layer: the group around a single rectangle collapses into the rectangle.
  const box = comp.layers[1]!;
  assert.equal(box.parentId, '1');
  assert.ok(box.content.type === 'group');
  const rect = box.content.children[0]!;
  assert.equal(rect.name, 'Rectangle 1');
  assert.ok(rect.content.type === 'rect' && rect.content.size.mode === 'vec');
  assert.equal(rect.content.size.a.k!.length, 2);
  assert.deepEqual(rect.content.size.a.k![1]!.e, { type: 'bezier', x1: 0.3333, y1: 0, x2: 0.6667, y2: 1 });
  assert.equal(rect.content.radius.v, 8);
  assert.deepEqual(rect.content.style.fills[0]!.color.v, { r: 1, g: 0, b: 0, a: 0.5 });
  assert.equal(rect.content.style.strokes.length, 1);
  assert.equal(rect.content.style.strokeWidth!.v, 4);
  assert.equal(rect.content.style.cap, 'round');
  assert.deepEqual(box.transform.opacity.k!.map((k) => k.v), [0, 1]);

  const title = comp.layers[2]!;
  assert.ok(title.content.type === 'text');
  assert.equal(title.content.text, 'Hello\nWorld');
  assert.equal(title.content.align, 'center');
  assert.equal(title.content.lineHeight, 48);
  assert.deepEqual(title.content.firstBaseline, { x: 0, y: 0 });
  assert.deepEqual([title.inPoint, title.outPoint], [0.5, 1.5]);

  // A curved motion path cannot be one easing curve, so it arrives as sampled linear keys.
  const curve = comp.layers[3]!;
  assert.ok(curve.transform.position.mode === 'vec');
  const curveKeys = curve.transform.position.a.k!;
  assert.ok(curveKeys.length >= 2);
  assert.ok(curveKeys.every((k) => !k.e));

  const bg = comp.layers[4]!;
  assert.ok(bg.transform.scale.mode === 'vec');
  assert.deepEqual(bg.transform.scale.a.v, { x: 0.5, y: 0.5 });
  assert.equal(bg.blendMode, 'multiply');
  assert.ok(doc.warnings.some((w) => w.layer === 'BG' && w.message.includes('Gaussian Blur')));
  assert.ok(doc.warnings.some((w) => w.message.includes('Camera')));

  const pre = comp.layers[5]!;
  assert.deepEqual(pre.content, { type: 'comp', compId: '20', width: 400, height: 300, startTime: 0.5 });

  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.file, 'C:/footage/photo.png');
  assert.ok(doc.assets[assets[0]!.assetId]);

  // And the whole thing builds, with the shape following its parent.
  installMockFigma();
  const out = buildDocument({ doc, images: {}, fonts: new Map() });
  const root = out.frame as unknown as MockNode;
  assert.deepEqual(out.motion.problems, []);
  assert.ok(out.motion.tracks >= 8, `expected a good number of tracks, got ${out.motion.tracks}`);
  assert.ok(findNode(root, 'CTRL', 'FRAME'), 'the null became a frame holding its children');
  const boxNode = findNode(root, 'Box', 'RECTANGLE');
  assert.ok(boxNode);
  assert.ok(boxNode.tracks.has('WIDTH'));
  for (const t of [0, 0.4, 1, 1.7, 3]) {
    // Whatever its width at t, the rectangle stays centred on the layer's origin.
    const size = nodeSize(boxNode, t);
    const got = apply(worldMatrix(boxNode, root, t), { x: size.x / 2, y: size.y / 2 });
    const expected = apply(layerMatrix(comp, box, t), { x: 0, y: 0 });
    assert.ok(Math.hypot(got.x - expected.x, got.y - expected.y) < 0.02, `Box centre at t=${t}`);
  }
  assert.ok(out.warnings.some((w) => w.includes('photo.png')), 'the missing image is reported');
});

test('an update reads the still pose the design was built with, wherever the playhead is now', () => {
  const main = project();
  installAeGlobals(main);
  const host = loadHost();
  const read = (poster?: number | null): RawDump => {
    const result = JSON.parse(poster === undefined ? host.beginExport([], String(main.id)) : host.beginExport([], String(main.id), poster)) as HostResult<RawDump>;
    assert.ok(result.ok, result.ok ? '' : `${result.message} (line ${result.line})`);
    host.endExport();
    return result.data;
  };
  const ctrlX = (dump: RawDump): number => (dump.comps[dump.rootId]!.layers[0]!.tr!.p!.v as number[])[0]!;

  // The playhead is parked at 1 s, where CTRL has arrived at x = 300.
  assert.equal(read().poster, 1);
  assert.equal(ctrlX(read()), 300);
  // The design was built from the pose at 0 s: that is what is read again.
  const then = read(0);
  assert.equal(then.poster, 0);
  assert.equal(ctrlX(then), 100);
  assert.equal(read(null).poster, 1, 'no pose given: the playhead');
  assert.equal(read(99).poster <= main.duration, true, 'a pose beyond the end is brought back into the composition');
  assert.equal(main.time, 1, 'the playhead itself is not moved');
});

/**
 * A limb rigged the way Duik rigs the user's characters. The arm, forearm and
 * hand are turned by IK expressions, and each of Duik's expressions hands back
 * its angle a whole turn away now and then: the two-layer IK adds 360 below a
 * limit, its second layer wraps with `% 360`, the one-layer IK follows atan2
 * across 180. After Effects only shows frames, where those are the same
 * picture; the motion in between has to be the smooth one.
 */
test('a rig whose IK expressions jump a whole turn between frames turns smoothly in Figma', () => {
  const deg = Math.PI / 180;
  // The smooth angle each expression means, and what the expression really returns.
  const armAngle = (t: number): number => 150 + 70 * Math.sin(Math.PI * t);
  const armIK = (t: number): number => {
    const IK = armAngle(t);
    return IK < 180 ? IK + 360 : IK;
  };
  const foreAngle = (t: number): number => 330 + 50 * Math.sin((2 * Math.PI * t) / 1.6);
  const foreIK = (t: number): number => foreAngle(t) % 360;
  const handAngle = (t: number): number => 160 + 40 * Math.cos(Math.PI * t * 1.5);
  const handIK = (t: number): number => Math.atan2(Math.sin(handAngle(t) * deg), Math.cos(handAngle(t) * deg)) / deg;
  // The shoulder is keyed, beyond half a turn and past a whole one.
  const shoulderAngle = (t: number): number => (t <= 1 ? -40 + 240 * t : 200 + 200 * (t - 1));

  const main = new CompItem(40, 'Character', 800, 600, 2);
  const solid = (id: number, name: string, w: number, h: number): Record<string, unknown> => ({
    source: new FootageItem(id, name, w, h, new SolidSource([1, 0.5, 0])),
    width: w,
    height: h,
  });
  const point = (x: number, y: number, name = 'ADBE Position'): Prop => new Prop(name, PVT.ThreeD_SPATIAL, [x, y, 0]);
  const rotation = (text: string, fn: (t: number) => number): Prop => new Prop('ADBE Rotate Z', PVT.OneD, fn(0)).expr(text, fn);
  const spec = {
    Hand: { w: 50, h: 30, a: [10, 15], p: [110, 10], r: handAngle },
    Forearm: { w: 120, h: 20, a: [10, 10], p: [130, 10], r: foreAngle },
    UpperArm: { w: 140, h: 20, a: [10, 10], p: [20, 20], r: armAngle },
    Shoulder: { w: 40, h: 40, a: [20, 20], p: [400, 300], r: shoulderAngle },
  };
  const hand = makeLayer(main, 'Hand', 'ADBE AV Layer', [
    transformGroup({
      anchor: point(10, 15, 'ADBE Anchor Point'),
      position: point(110, 10),
      rotation: rotation('//Duik.oneLayerIK\nvar angle = Math.atan2(vec[1], vec[0]);\nangle = radiansToDegrees(angle);\nresult += angle;', handIK),
    }),
  ], solid(41, 'Hand', 50, 30));
  const forearm = makeLayer(main, 'Forearm', 'ADBE AV Layer', [
    transformGroup({
      anchor: point(10, 10, 'ADBE Anchor Point'),
      position: point(130, 10),
      rotation: rotation('//Duik.twoLayerIK\nIK = result + adj1 - adj2 + value;\nreturn IK % 360;', foreIK),
    }),
  ], solid(42, 'Forearm', 120, 20));
  const upper = makeLayer(main, 'UpperArm', 'ADBE AV Layer', [
    transformGroup({
      anchor: point(10, 10, 'ADBE Anchor Point'),
      position: point(20, 20),
      rotation: rotation('//Duik.twoLayerIK\nIK = result - adj1 + value;\nif (IK < limit) IK+=360;\nreturn IK;', armIK),
    }),
  ], solid(43, 'UpperArm', 140, 20));
  const shoulder = makeLayer(main, 'Shoulder', 'ADBE AV Layer', [
    transformGroup({
      anchor: point(20, 20, 'ADBE Anchor Point'),
      position: point(400, 300),
      rotation: new Prop('ADBE Rotate Z', PVT.OneD, -40, [
        { time: 0, value: -40, ...LINEAR },
        { time: 1, value: 200, ...LINEAR },
        { time: 2, value: 400, ...LINEAR },
      ]),
    }),
  ], solid(44, 'Shoulder', 40, 40));
  hand.parent = forearm;
  forearm.parent = upper;
  upper.parent = shoulder;

  installAeGlobals(main);
  const result = JSON.parse(loadHost().exportActiveComp()) as HostResult<RawDump>;
  assert.ok(result.ok, result.ok ? '' : `${result.message} (line ${result.line})`);
  const raw = result.data.comps[result.data.rootId]!.layers;
  assert.ok(raw.find((l) => l.name === 'UpperArm')!.tr!.r!.s, 'the IK rotation is sampled per frame');
  const { doc } = convertAeDump(result.data);
  const comp = doc.comps[doc.rootCompId]!;

  // Figma, played between the frames too, against the smooth After Effects motion.
  installMockFigma();
  const out = buildDocument({ doc, images: {}, fonts: new Map() });
  const root = out.frame as unknown as MockNode;
  assert.deepEqual(out.motion.problems, []);
  const chainOf: Array<keyof typeof spec> = ['Hand', 'Forearm', 'UpperArm', 'Shoulder'];
  const aeMatrix = (name: keyof typeof spec, t: number): Mat => {
    let m: Mat = [1, 0, 0, 1, 0, 0];
    for (const n of chainOf.slice(chainOf.indexOf(name))) {
      const s = spec[n];
      m = mul(chain(translate(s.p[0]!, s.p[1]!), rotateMat(s.r(t)), translate(-s.a[0]!, -s.a[1]!)), m);
    }
    return m;
  };
  let worst = { err: 0, at: '' };
  for (const name of chainOf) {
    const node = findNode(root, name, 'RECTANGLE');
    assert.ok(node, `"${name}" is built`);
    const s = spec[name];
    for (let i = 0; i <= 480; i++) {
      const t = i / 240;
      const fig = worldMatrix(node, root, t);
      const size = nodeSize(node, t);
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]>) {
        const got = apply(fig, { x: u * size.x, y: v * size.y });
        const expected = apply(aeMatrix(name, t), { x: u * s.w, y: v * s.h });
        const err = Math.hypot(got.x - expected.x, got.y - expected.y);
        if (err > worst.err) worst = { err, at: `"${name}" corner (${u},${v}) at t=${t.toFixed(4)}` };
      }
    }
  }
  assert.ok(worst.err < 1, `the limbs follow After Effects between frames; worst ${worst.err.toFixed(2)} px at ${worst.at}`);

  // The keys themselves never step by a turn: each sampled rotation is continuous.
  for (const name of ['UpperArm', 'Forearm', 'Hand']) {
    const rot = comp.layers.find((l) => l.name === name)!.transform.rotation;
    let step = 0;
    for (let i = 1; i <= 480; i++) step = Math.max(step, Math.abs(evalAnim(rot, i / 240, numOps) - evalAnim(rot, (i - 1) / 240, numOps)));
    assert.ok(step < 10, `"${name}": the rotation moves ${step.toFixed(1)} degrees within 1/240 s`);
  }
});

test('host.jsx explains itself when no composition is open', () => {
  installAeGlobals(null as unknown as CompItem);
  const host = loadHost();
  const result = JSON.parse(host.exportActiveComp()) as HostResult<RawDump>;
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === 'NO_COMP');
});
