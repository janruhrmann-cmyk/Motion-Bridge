/**
 * Figma -> After Effects, the Figma half: reads frames of the stand-in Figma
 * into documents (figma-plugin/src/read/reader.ts).
 *
 * The first tests go all the way round: a document is built into Figma the
 * way a transfer from After Effects is, read back, and has to describe the
 * same motion - every corner in the same place at every sampled time. The
 * rest check how a design that was made in Figma is told as a composition.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocument } from '../figma-plugin/src/build/builder.ts';
import { pushable, readFrames } from '../figma-plugin/src/read/reader.ts';
import { evalAnim, evalAnimVec, numOps, rgbaOps } from '../shared/anim.ts';
import type { BridgeDoc, Comp, Content, Ease, Layer, Rect, RGBA } from '../shared/format.ts';
import type { MockFigma, MockNode } from './sim.ts';
import { apply, compOf, docOf, installMockFigma, layerMatrix, solidLayer, transform as tr, vec, vecKeys } from './sim.ts';

const EASE: Ease = { type: 'bezier', x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
const OVERSHOOT: Ease = { type: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
const paint = (r: number, g: number, b: number, opacity = 1): unknown => ({ type: 'SOLID', color: { r, g, b }, opacity, visible: true });

async function read(nodes: MockNode[]): Promise<{ docs: BridgeDoc[]; images: Record<string, Uint8Array> }> {
  return readFrames(nodes as unknown as SceneNode[]);
}

async function readOne(node: MockNode): Promise<{ doc: BridgeDoc; root: Comp; images: Record<string, Uint8Array> }> {
  const { docs, images } = await read([node]);
  const doc = docs[0]!;
  return { doc, root: doc.comps[doc.rootCompId]!, images };
}

function drawn(content: Content): Content {
  let c = content;
  while (c.type === 'group' && c.children.length === 1) c = c.children[0]!.content;
  return c;
}

/** The box a layer's content covers in its own space at time t. */
function boxOf(content: Content, t: number): Rect | null {
  switch (content.type) {
    case 'rect':
    case 'ellipse': {
      const s = evalAnimVec(content.size, t);
      return { x: -s.x / 2, y: -s.y / 2, w: s.x, h: s.y };
    }
    case 'solid':
    case 'image':
    case 'comp':
      return { x: 0, y: 0, w: content.width, h: content.height };
    default:
      return null;
  }
}

const cornersOf = (r: Rect): Array<{ x: number; y: number }> => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];

/** Builds a document into Figma the way a transfer does, and reads the frame back. */
async function roundTrip(doc: BridgeDoc): Promise<{ mock: MockFigma; back: BridgeDoc; root: Comp }> {
  const mock = installMockFigma();
  const out = buildDocument({ doc, images: {}, fonts: new Map(), components: false });
  assert.deepEqual(out.motion.problems, []);
  const { doc: back, root } = await readOne(out.frame as unknown as MockNode);
  return { mock, back, root };
}

/** Every layer of `want` that draws a box is in `got` under its name, and its box is in the same place all the time. */
function assertSameBoxes(want: Comp, got: Comp, names: string[]): void {
  for (const name of names) {
    const a = want.layers.find((l) => l.name === name)!;
    const b = got.layers.find((l) => l.name === name && l.content.type !== 'empty');
    assert.ok(b, `"${name}" was read back as a layer that draws`);
    for (let t = 0; t <= want.duration + 1e-9; t += 0.05) {
      const ba = boxOf(drawn(a.content), t)!;
      const bb = boxOf(drawn(b.content), t);
      assert.ok(bb, `"${name}" came back as a box`);
      const pa = cornersOf(ba).map((p) => apply(layerMatrix(want, a, t), p));
      const pb = cornersOf(bb).map((p) => apply(layerMatrix(got, b, t), p));
      pa.forEach((p, i) => {
        assert.ok(Math.hypot(p.x - pb[i]!.x, p.y - pb[i]!.y) < 0.1, `"${name}" corner ${i} at ${t.toFixed(2)} s: (${pb[i]!.x.toFixed(2)}, ${pb[i]!.y.toFixed(2)}), expected (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
      });
      const oa = t >= a.inPoint && t < a.outPoint ? evalAnim(a.transform.opacity, t, numOps) : 0;
      assert.ok(Math.abs(oa - evalAnim(b.transform.opacity, t, numOps)) < 0.01, `"${name}" opacity at ${t.toFixed(2)} s`);
    }
  }
}

test('motion sent to Figma and read back is the same motion', async () => {
  const layers: Layer[] = [
    // Anchor in the middle: the tracks sit on the node itself.
    solidLayer('1', 'Card', 200, 100, {
      anchor: vec(100, 50),
      position: vecKeys([{ t: 0, v: { x: 100, y: 100 } }, { t: 1, v: { x: 500, y: 300 }, e: EASE }, { t: 2, v: { x: 500, y: 100 } }]),
      rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 180, e: OVERSHOOT }] },
      scale: vecKeys([{ t: 0.5, v: { x: 1, y: 1 } }, { t: 1.5, v: { x: 2, y: 0.5 }, e: EASE }]),
    }),
    // Anchor in a corner: Figma needs a pivot frame around it, which comes back as a null the layer follows.
    solidLayer('2', 'Door', 200, 100, { anchor: vec(0, 0), position: vec(300, 200), rotation: { v: 0, k: [{ t: 0, v: -30 }, { t: 2, v: 90, e: EASE }] }, scale: vec(1.5, 0.5) }),
    solidLayer('3', 'Ball', 60, 60, {
      anchor: vec(30, 30),
      position: { mode: 'split', x: { v: 100, k: [{ t: 0, v: 100 }, { t: 2, v: 700 }] }, y: { v: 500, k: [{ t: 0, v: 500 }, { t: 1, v: 100, e: EASE }, { t: 2, v: 500, e: EASE }] } },
    }),
    solidLayer('4', 'Arm', 120, 20, { anchor: vec(0, 10), position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 2, v: { x: 80, y: 0 }, e: EASE }]) }, { parentId: '5' }),
    {
      id: '5',
      name: 'Shoulder',
      transform: tr({ position: vec(400, 450), rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: -90, e: EASE }] } }),
      content: { type: 'empty', width: 100, height: 100 },
      inPoint: 0,
      outPoint: 100,
    },
    solidLayer('6', 'Fader', 80, 80, { anchor: vec(40, 40), position: vec(700, 80), rotation: { v: 30 }, opacity: { v: 1, k: [{ t: 0, v: 0 }, { t: 1, v: 1, e: EASE }, { t: 2, v: 0.25 }] } }),
  ];
  const comp = compOf('root', layers);
  const { back, root } = await roundTrip(docOf([comp]));

  assert.equal(back.source.app, 'figma');
  assert.equal(root.duration, 2, 'the frame has its timeline\'s length');
  assert.equal(root.frameRate, 0, 'Figma has no frame rate to pass on');
  assert.deepEqual(Object.keys(back.comps), ['root'], 'nothing had to become a nested composition');
  assert.deepEqual(back.warnings, []);
  assertSameBoxes(comp, root, ['Card', 'Door', 'Ball', 'Arm', 'Fader']);

  // Nothing is sampled where a track can be taken over as it is.
  const card = root.layers.find((l) => l.name === 'Card')!;
  assert.equal(card.transform.position.mode, 'vec');
  assert.equal(card.transform.position.mode === 'vec' && card.transform.position.a.k?.length, 3);
  assert.deepEqual(card.transform.rotation.k?.[1]?.e, OVERSHOOT);
  const ball = root.layers.find((l) => l.name === 'Ball')!;
  assert.equal(ball.transform.position.mode, 'split');
  // The arm follows its shoulder, as it did in After Effects.
  const arm = root.layers.find((l) => l.name === 'Arm' && l.content.type !== 'empty')!;
  assert.ok(arm.parentId !== undefined);
});

test('animated sizes, corners, colours and trims come back as what they were', async () => {
  const tab: Layer = {
    id: '1',
    name: 'Tab',
    transform: tr({ position: vec(300, 200) }),
    content: {
      type: 'rect',
      size: { mode: 'vec', a: { v: { x: 160, y: 60 }, k: [{ t: 0, v: { x: 160, y: 60 } }, { t: 1, v: { x: 260, y: 60 }, e: EASE }] } },
      radius: { v: 10, k: [{ t: 0, v: 10 }, { t: 1, v: 30, e: EASE }] },
      style: { fills: [{ color: { v: rgba(1, 0.5, 0), k: [{ t: 0, v: rgba(1, 0.5, 0) }, { t: 2, v: rgba(0.9, 0.1, 0.3), e: EASE }] } }], strokes: [] },
    },
    inPoint: 0,
    outPoint: 100,
  };
  const line: Layer = {
    id: '2',
    name: 'Line',
    transform: tr({ position: vec(100, 400) }),
    content: {
      type: 'path',
      paths: [{ closed: false, v: [{ x: 0, y: 0 }, { x: 150, y: 60 }, { x: 300, y: 0 }], i: [{ x: 0, y: 0 }, { x: -50, y: 0 }, { x: 0, y: 0 }], o: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0 }] }],
      style: { fills: [], strokes: [{ color: { v: rgba(0.5, 0.1, 0.8) } }], strokeWidth: { v: 6 }, cap: 'round', trim: { start: { v: 0 }, end: { v: 1, k: [{ t: 0, v: 0 }, { t: 1.5, v: 1, e: EASE }] }, offset: { v: 0 } } },
    },
    inPoint: 0,
    outPoint: 100,
  };
  const comp = compOf('root', [tab, line]);
  const { root } = await roundTrip(docOf([comp]));
  assertSameBoxes(comp, root, ['Tab']);

  const readTab = drawn(root.layers.find((l) => l.name === 'Tab')!.content);
  assert.ok(readTab.type === 'rect' && tab.content.type === 'rect');
  for (let t = 0; t <= 2.0001; t += 0.1) {
    assert.ok(Math.abs(evalAnim(readTab.radius, t, numOps) - evalAnim(tab.content.radius, t, numOps)) < 0.01, `radius at ${t.toFixed(1)} s`);
    assert.ok(rgbaOps.dist(evalAnim(readTab.style.fills[0]!.color, t, rgbaOps), evalAnim(tab.content.style.fills[0]!.color, t, rgbaOps)) < 0.005, `colour at ${t.toFixed(1)} s`);
  }

  const readLine = root.layers.find((l) => l.name === 'Line')!;
  const c = readLine.content;
  assert.ok(c.type === 'path' && line.content.type === 'path');
  assert.equal(c.paths.length, 1);
  assert.equal(c.paths[0]!.closed, false);
  assert.equal(c.paths[0]!.v.length, 3);
  assert.equal(c.style.cap, 'round');
  assert.equal(c.style.strokeWidth?.v, 6);
  assert.deepEqual(c.style.trim?.end.k, line.content.style.trim!.end.k);
  // The outline starts in the same place: the path is drawn from the node's corner, the layer is anchored on its middle.
  const start = apply(layerMatrix(root, readLine, 0), c.paths[0]!.v[0]!);
  assert.ok(Math.hypot(start.x - 100, start.y - 400) < 0.05, `the line starts at (${start.x}, ${start.y})`);
});

// ------------------------------------------------- designs made in Figma

interface Tree {
  mock: MockFigma;
  frame: MockNode;
}

function newFrame(mock: MockFigma, name: string, w: number, h: number, parent?: MockNode, x = 0, y = 0): MockNode {
  const f = mock.createFrame();
  f.name = name;
  f.resize(w, h);
  if (parent) parent.appendChild(f);
  f.x = x;
  f.y = y;
  return f;
}

function newRect(mock: MockFigma, name: string, parent: MockNode, x: number, y: number, w: number, h: number, fill: unknown = paint(1, 0, 0)): MockNode {
  const r = mock.createRectangle();
  r.name = name;
  r.resize(w, h);
  parent.appendChild(r);
  r.x = x;
  r.y = y;
  r.fills = [fill];
  return r;
}

function design(w = 400, h = 300): Tree {
  const mock = installMockFigma();
  const frame = newFrame(mock, 'Design', w, h);
  frame.fills = [paint(0.9, 0.9, 0.9)];
  return { mock, frame };
}

const positionOf = (layer: Layer): { x: number; y: number } => evalAnimVec(layer.transform.position, 0);
const named = (comp: Comp, name: string): Layer => {
  const layer = comp.layers.find((l) => l.name === name);
  assert.ok(layer, `there is a layer "${name}"`);
  return layer;
};

test('a frame with a fill is a shape layer its children follow; a frame that only holds things disappears', async () => {
  const { mock, frame } = design();
  const card = newFrame(mock, 'Card', 200, 100, frame, 50, 40);
  card.fills = [paint(1, 1, 1)];
  card.cornerRadius = 12;
  const title = mock.createText();
  title.name = 'Title';
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.characters = 'Hello';
  title.fontSize = 20;
  title.lineHeight = { value: 24, unit: 'PIXELS' };
  title.fills = [paint(0.1, 0.1, 0.1)];
  card.appendChild(title);
  title.x = 10;
  title.y = 10;
  const row = newFrame(mock, 'Row', 100, 30, card, 10, 50);
  newRect(mock, 'Chip', row, 5, 5, 40, 20);

  const { doc, root } = await readOne(frame);
  assert.deepEqual(root.layers.map((l) => l.name), ['Chip', 'Title', 'Card', 'Background'], 'front-most first; "Row" is gone');
  assert.deepEqual(Object.keys(doc.comps), ['root']);
  assert.equal(root.duration, 0, 'nothing moves, so the frame has no length of its own');
  assert.deepEqual([root.width, root.height], [400, 300]);
  assert.deepEqual(root.background, rgba(0.9, 0.9, 0.9));

  const cardLayer = named(root, 'Card');
  const c = cardLayer.content;
  assert.ok(c.type === 'rect');
  assert.deepEqual(evalAnimVec(c.size, 0), { x: 200, y: 100 });
  assert.equal(c.radius.v, 12);
  assert.deepEqual(positionOf(cardLayer), { x: 150, y: 90 }, 'placed by its middle');
  assert.equal(cardLayer.parentId, undefined);

  // What is inside counts from the card's middle, which is where the shape layer's own space starts.
  const chip = named(root, 'Chip');
  assert.equal(chip.parentId, cardLayer.id);
  assert.deepEqual(positionOf(chip), { x: 10 + 5 + 20 - 100, y: 50 + 5 + 10 - 50 });
  assert.equal(named(root, 'Title').parentId, cardLayer.id);
  // And on the page it is where Figma has it.
  const corner = apply(layerMatrix(root, chip, 0), { x: -20, y: -10 });
  assert.deepEqual(corner, { x: 50 + 10 + 5, y: 40 + 50 + 5 });
});

test('a frame that clips what pokes out is a nested composition, with its rounded corners as a matte', async () => {
  const { mock, frame } = design();
  const clip = newFrame(mock, 'Window', 200, 100, frame, 50, 40);
  clip.fills = [paint(1, 1, 1)];
  clip.cornerRadius = 20;
  newRect(mock, 'Sun', clip, 150, -30, 100, 100);
  // The same frame with everything inside it needs no composition.
  const tidy = newFrame(mock, 'Tidy', 100, 100, frame, 280, 180);
  tidy.fills = [paint(0, 0, 1)];
  newRect(mock, 'Inside', tidy, 30, 30, 40, 40);

  const { doc, root } = await readOne(frame);
  assert.deepEqual(root.layers.map((l) => l.name), ['Inside', 'Tidy', 'Window corners', 'Window', 'Background']);
  const window = named(root, 'Window');
  assert.ok(window.content.type === 'comp');
  const inner = doc.comps[window.content.compId]!;
  assert.deepEqual([inner.width, inner.height], [200, 100]);
  assert.deepEqual(inner.layers.map((l) => l.name), ['Sun', 'Background']);
  assert.deepEqual(positionOf(named(inner, 'Sun')), { x: 200, y: 20 }, 'counted from the frame\'s own corner');
  assert.deepEqual(positionOf(window), { x: 150, y: 90 });
  assert.deepEqual(evalAnimVec(window.transform.anchor, 0), { x: 100, y: 50 });

  const corners = named(root, 'Window corners');
  assert.deepEqual(window.matte, { layerId: corners.id });
  assert.equal(corners.hidden, true);
  assert.equal(corners.parentId, window.id, 'the matte follows the layer it cuts');
  assert.ok(corners.content.type === 'rect' && corners.content.radius.v === 20);
  assert.equal(named(root, 'Tidy').content.type, 'rect');
});

test('a frame that clips also becomes a composition when something moves inside it', async () => {
  const { mock, frame } = design();
  const clip = newFrame(mock, 'Stage', 200, 100, frame, 50, 40);
  const actor = newRect(mock, 'Actor', clip, 20, 20, 40, 40);
  // It starts inside and slides out: only the timeline knows.
  actor.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'TRANSLATION_X' }, { keyframes: [{ timelinePosition: 0, value: { type: 'FLOAT', value: 0 } }, { timelinePosition: 1, value: { type: 'FLOAT', value: 300 }, easing: { type: 'EASE_OUT' } }] });
  mock.timelineDuration = 1.5;

  const { doc, root } = await readOne(frame);
  const stage = named(root, 'Stage');
  assert.ok(stage.content.type === 'comp');
  assert.equal(root.duration, 1.5);
  const inner = doc.comps[stage.content.compId]!;
  assert.equal(inner.duration, 1.5);
  const moving = named(inner, 'Actor').transform.position;
  assert.ok(moving.mode === 'split' && moving.x.k);
  assert.deepEqual(moving.x.k.map((k) => k.v), [40, 340], 'the track adds to where the node rests');
  // Figma's named eases arrive as the curves they are.
  assert.deepEqual(moving.x.k[1]!.e, { type: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 });
});

test('a mask is a track matte for the layers above it', async () => {
  const { mock, frame } = design();
  newRect(mock, 'Below', frame, 0, 0, 50, 50);
  const mask = mock.createEllipse();
  mask.name = 'Porthole';
  mask.resize(100, 100);
  frame.appendChild(mask);
  mask.fills = [paint(0, 0, 0)];
  mask.isMask = true;
  newRect(mock, 'Sea', frame, 0, 0, 200, 200);
  newRect(mock, 'Boat', frame, 20, 20, 30, 30);

  const { root } = await readOne(frame);
  assert.deepEqual(root.layers.map((l) => l.name), ['Boat', 'Sea', 'Porthole', 'Below', 'Background']);
  const porthole = named(root, 'Porthole');
  assert.equal(porthole.hidden, true);
  assert.equal(porthole.content.type, 'ellipse');
  assert.deepEqual(named(root, 'Sea').matte, { layerId: porthole.id });
  assert.deepEqual(named(root, 'Boat').matte, { layerId: porthole.id });
  assert.equal(named(root, 'Below').matte, undefined);
});

test('a group that fades several things as one is a composition; around one thing it hands its opacity down', async () => {
  const { mock, frame } = design();
  const a = newRect(mock, 'A', frame, 10, 10, 50, 50);
  const b = newRect(mock, 'B', frame, 40, 40, 50, 50);
  const pair = mock.group([a, b], frame);
  pair.name = 'Pair';
  pair.opacity = 0.5;
  const solo = newRect(mock, 'Solo', frame, 200, 10, 50, 50);
  solo.opacity = 0.5;
  const wrap = mock.group([solo], frame);
  wrap.name = 'Wrap';
  wrap.opacity = 0.5;
  wrap.blendMode = 'MULTIPLY';

  const { doc, root } = await readOne(frame);
  assert.deepEqual(root.layers.map((l) => l.name), ['Solo', 'Pair', 'Background']);
  const pairLayer = named(root, 'Pair');
  assert.ok(pairLayer.content.type === 'comp');
  assert.equal(pairLayer.transform.opacity.v, 0.5);
  const inner = doc.comps[pairLayer.content.compId]!;
  assert.deepEqual(inner.layers.map((l) => l.name), ['B', 'A']);
  // A group has no space of its own: what is inside is placed in the frame, and the composition starts at the group's corner.
  assert.deepEqual(positionOf(named(inner, 'A')), { x: 25, y: 25 });
  assert.deepEqual(positionOf(pairLayer), { x: 50, y: 50 });

  const soloLayer = named(root, 'Solo');
  assert.equal(soloLayer.content.type, 'rect');
  assert.equal(soloLayer.transform.opacity.v, 0.25);
  assert.equal(soloLayer.blendMode, 'multiply');
  assert.deepEqual(positionOf(soloLayer), { x: 225, y: 35 });
});

test('a stroke inside the outline gets an outline of its own', async () => {
  const { mock, frame } = design();
  const box = newRect(mock, 'Box', frame, 10, 10, 100, 60);
  box.strokes = [paint(0, 0, 0)];
  box.strokeWeight = 4;
  box.strokeAlign = 'INSIDE';
  box.cornerRadius = 10;
  const ring = mock.createEllipse();
  ring.name = 'Ring';
  ring.resize(50, 50);
  frame.appendChild(ring);
  ring.strokes = [paint(0, 0, 0)];
  ring.strokeWeight = 6;
  ring.strokeAlign = 'CENTER';

  const { root } = await readOne(frame);
  const c = named(root, 'Box').content;
  assert.ok(c.type === 'group');
  assert.deepEqual(c.children.map((e) => e.name), ['Stroke', 'Fill']);
  const [stroke, fill] = c.children.map((e) => e.content);
  assert.ok(stroke!.type === 'rect' && fill!.type === 'rect');
  assert.deepEqual(evalAnimVec(stroke!.size, 0), { x: 96, y: 56 });
  assert.equal(stroke!.radius.v, 8);
  assert.equal(stroke!.style.strokeWidth?.v, 4);
  assert.equal(stroke!.style.fills.length, 0);
  assert.deepEqual(evalAnimVec(fill!.size, 0), { x: 100, y: 60 });
  assert.equal(fill!.style.strokes.length, 0);

  const r = named(root, 'Ring').content;
  assert.ok(r.type === 'ellipse');
  assert.deepEqual(evalAnimVec(r.size, 0), { x: 50, y: 50 }, 'a centred stroke sits on the outline as it is');
  assert.equal(r.style.strokes.length, 1);
});

test('what After Effects has no shape for arrives as a picture of it', async () => {
  const { mock, frame } = design();
  const sky = newRect(mock, 'Sky', frame, 100, 50, 200, 100, { type: 'GRADIENT_LINEAR', visible: true, opacity: 1, gradientStops: [] });
  sky.opacity = 0.5;
  newRect(mock, 'Plain', frame, 0, 0, 20, 20);

  const { doc, root, images } = await readOne(frame);
  assert.deepEqual(mock.exports, ['Sky'], 'only the gradient needs a picture');
  const layer = named(root, 'Sky');
  const c = layer.content;
  assert.ok(c.type === 'image');
  assert.deepEqual([c.width, c.height], [200, 100]);
  const asset = doc.assets[c.assetId]!;
  // Exported at twice its size, so there is something to scale up with.
  assert.deepEqual([asset.width, asset.height], [400, 200]);
  assert.ok(images[c.assetId] instanceof Uint8Array);
  assert.deepEqual(evalAnimVec(layer.transform.anchor, 0), { x: 100, y: 50 });
  assert.deepEqual(positionOf(layer), { x: 200, y: 100 });
  assert.equal(layer.transform.opacity.v, 1, 'the picture already has the node\'s opacity in its pixels');
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0]!.message, /a gradient as its fill/);
  assert.equal(doc.warnings[0]!.layer, 'Sky');
});

test('a picture a frame is filled with arrives whole, placed the way Figma crops it', async () => {
  const mock = installMockFigma();
  const frame = newFrame(mock, 'Poster', 200, 100);
  mock.pictures.set('abc', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), width: 400, height: 400 });
  frame.fills = [paint(1, 1, 1), { type: 'IMAGE', scaleMode: 'FILL', imageHash: 'abc', visible: true, opacity: 0.8 }];
  newRect(mock, 'Label', frame, 10, 10, 50, 20);

  const { doc, root, images } = await readOne(frame);
  assert.deepEqual(root.layers.map((l) => l.name), ['Label', 'Poster picture', 'Background']);
  const picture = named(root, 'Poster picture');
  const c = picture.content;
  assert.ok(c.type === 'image');
  assert.deepEqual([c.width, c.height], [400, 400]);
  assert.equal(doc.assets[c.assetId]!.mime, 'image/jpeg');
  assert.equal(images[c.assetId]!.length, 4);
  // Covering 200 x 100 with a square picture: half its size, centred, the composition cuts off the rest.
  assert.deepEqual(evalAnimVec(picture.transform.scale, 0), { x: 0.5, y: 0.5 });
  assert.deepEqual(positionOf(picture), { x: 100, y: 50 });
  assert.deepEqual(evalAnimVec(picture.transform.anchor, 0), { x: 200, y: 200 });
  assert.equal(picture.transform.opacity.v, 0.8);
});

test('text keeps its words, font, size, colour and spacing, and says where its glyphs are', async () => {
  const { mock, frame } = design();
  const t = mock.createText();
  t.name = 'Headline';
  t.fontName = { family: 'Brand Sans Display', style: 'Extra Bold' };
  t.characters = 'Free delivery\nthis week';
  t.fontSize = 40;
  t.lineHeight = { value: 44, unit: 'PIXELS' };
  t.letterSpacing = { value: -2, unit: 'PERCENT' };
  t.textAlignHorizontal = 'CENTER';
  t.textCase = 'UPPER';
  t.fills = [paint(1, 0.5, 0, 0.5)];
  frame.appendChild(t);
  t.x = 30;
  t.y = 60;

  const { root } = await readOne(frame);
  const layer = named(root, 'Headline');
  const c = layer.content;
  assert.ok(c.type === 'text');
  assert.equal(c.text, 'Free delivery\nthis week');
  assert.deepEqual([c.fontFamily, c.fontStyle, c.fontSize], ['Brand Sans Display', 'Extra Bold', 40]);
  assert.equal(c.align, 'center');
  assert.equal(c.caps, 'all');
  assert.equal(c.tracking, -20);
  assert.equal(c.lineHeight, 44);
  assert.deepEqual(c.fill, rgba(1, 0.5, 0));
  assert.equal(layer.transform.opacity.v, 0.5, 'the fill\'s opacity becomes the layer\'s');
  assert.equal(c.box, undefined, 'text that is as wide as its words is point text');
  // The glyphs are measured, so After Effects can line them up without knowing the font.
  assert.deepEqual(c.ink, { x: 0, y: 0, w: t.width, h: t.height });
  const topLeft = apply(layerMatrix(root, layer, 0), { x: c.ink!.x, y: c.ink!.y });
  assert.deepEqual(topLeft, { x: 30, y: 60 });
});

test('several tracks on one property add up, and a spring stays a spring', async () => {
  const { mock, frame } = design();
  const box = newRect(mock, 'Box', frame, 0, 0, 100, 100);
  const key = (t: number, value: number, easing?: unknown): unknown => ({ timelinePosition: t, value: { type: 'FLOAT', value }, easing });
  // Its own keyframes, plus an animation style that nudges it along.
  Object.defineProperty(box, 'animations', {
    value: {
      TRANSLATION_X: {
        tracks: [
          { keyframeOperation: 'OFFSET', keyframes: [key(0, 0), key(1, 100)] },
          { keyframeOperation: 'OFFSET', keyframes: [key(0, 0), key(1, 50)] },
        ],
      },
      ROTATION: { tracks: [{ keyframeOperation: 'OFFSET', keyframes: [key(0, 0), key(1, 90, { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } })] }] },
      OPACITY: { tracks: [{ keyframeOperation: 'SCALE', keyframes: [key(0, 0), key(1, 1)] }] },
    },
  });
  box.opacity = 0.8;
  mock.timelineDuration = 1;

  const { root } = await readOne(frame);
  const layer = named(root, 'Box');
  const p = layer.transform.position;
  assert.ok(p.mode === 'split' && p.x.k);
  assert.ok(Math.abs(evalAnim(p.x, 0.5, numOps) - (50 + 75)) < 0.01, 'half way: half of both tracks');
  assert.ok(Math.abs(evalAnim(p.x, 1, numOps) - 200) < 0.01);
  // Counter-clockwise in Figma, clockwise in After Effects.
  assert.deepEqual(layer.transform.rotation.k?.map((k) => k.v), [0, -90]);
  assert.deepEqual(layer.transform.rotation.k?.[1]?.e, { type: 'spring', bounce: 0.4 });
  // A track that multiplies works on the node's own opacity.
  assert.deepEqual(layer.transform.opacity.k?.map((k) => k.v), [0, 0.8]);
});

test('every selected frame becomes a document of its own, and a layer inside a selected frame is not sent twice', async () => {
  const mock = installMockFigma();
  const one = newFrame(mock, 'One', 100, 100);
  const inside = newRect(mock, 'Inside', one, 10, 10, 20, 20);
  const two = newFrame(mock, 'Two', 200, 100);
  two.x = 300;
  const hidden = newFrame(mock, 'Hidden', 50, 50);
  hidden.visible = false;

  const picked = pushable([one, inside, two, hidden] as unknown as SceneNode[]) as unknown as MockNode[];
  assert.deepEqual(picked.map((n) => n.name), ['One', 'Two']);
  const { docs } = await read(picked);
  assert.deepEqual(docs.map((d) => d.comps[d.rootCompId]!.name), ['One', 'Two']);
  assert.deepEqual(docs.map((d) => d.comps[d.rootCompId]!.width), [100, 200]);
  // A frame is read from its own corner, wherever it lies on the page.
  assert.deepEqual(docs[1]!.comps.root!.layers, []);
  // A single layer can be sent too: a composition of its size with it inside.
  const { root } = await readOne(inside);
  assert.deepEqual([root.width, root.height], [20, 20]);
  assert.deepEqual(positionOf(root.layers[0]!), { x: 10, y: 10 });
});
