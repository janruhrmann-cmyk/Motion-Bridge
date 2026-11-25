/**
 * Builds documents into the mock Figma, plays the written keyframes back and
 * checks every layer against the After Effects transform model: same corner
 * positions and same opacity at every sampled time.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeDoc, Comp, Ease, Layer, Vec2 } from '../shared/format.ts';
import { buildDocument } from '../figma-plugin/src/build/builder.ts';
import type { MockFigma, MockNode } from './sim.ts';
import {
  apply,
  compOf,
  docOf,
  findNode,
  installMockFigma,
  layerMatrix,
  layerOpacity,
  mul,
  nodeSize,
  paintOrder,
  solidLayer,
  translate,
  vec,
  vecKeys,
  worldMatrix,
  worldOpacity,
} from './sim.ts';
import type { Mat } from './sim.ts';

const EASE: Ease = { type: 'bezier', x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
const OVERSHOOT: Ease = { type: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

function build(doc: BridgeDoc, setup?: (mock: MockFigma) => void): { mock: MockFigma; root: MockNode; out: ReturnType<typeof buildDocument> } {
  const mock = installMockFigma();
  setup?.(mock);
  const out = buildDocument({ doc, images: {}, fonts: new Map() });
  return { mock, root: out.frame as unknown as MockNode, out };
}

function times(duration: number, step = 0.05): number[] {
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

function assertPoint(actual: Vec2, expected: Vec2, label: string, eps = 0.02): void {
  assert.ok(
    Math.abs(actual.x - expected.x) <= eps && Math.abs(actual.y - expected.y) <= eps,
    `${label}: got (${actual.x.toFixed(3)}, ${actual.y.toFixed(3)}), expected (${expected.x.toFixed(3)}, ${expected.y.toFixed(3)})`,
  );
}

/**
 * Compares a box-shaped piece of content with its Figma node. `box(t)` gives
 * the content's rectangle in the layer's space, `ae(t)` the reference matrix.
 */
function assertFollows(
  root: MockNode,
  node: MockNode | undefined,
  duration: number,
  ae: (t: number) => Mat,
  box: (t: number) => { x: number; y: number; w: number; h: number },
  opacity?: (t: number) => number,
): void {
  assert.ok(node, 'the Figma node exists');
  for (const t of times(duration)) {
    const fig = worldMatrix(node, root, t);
    const dims = nodeSize(node, t);
    const b = box(t);
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]] as Array<[number, number]>) {
      assertPoint(
        apply(fig, { x: u * dims.x, y: v * dims.y }),
        apply(ae(t), { x: b.x + u * b.w, y: b.y + v * b.h }),
        `"${node.name}" corner (${u},${v}) at t=${t}`,
      );
    }
    if (opacity) {
      const got = worldOpacity(node, root, t);
      assert.ok(Math.abs(got - opacity(t)) < 0.01, `"${node.name}" opacity at t=${t}: got ${got.toFixed(3)}, expected ${opacity(t).toFixed(3)}`);
    }
  }
}

function assertSolidFollows(root: MockNode, comp: Comp, layer: Layer, type = 'RECTANGLE'): MockNode {
  const node = findNode(root, layer.name, type);
  const c = layer.content;
  assert.ok(c.type === 'solid');
  assertFollows(
    root,
    node,
    comp.duration,
    (t) => layerMatrix(comp, layer, t),
    () => ({ x: 0, y: 0, w: c.width, h: c.height }),
    (t) => layerOpacity(layer, t),
  );
  return node!;
}

test('anchor in the centre: position, rotation and scale go straight onto the node', () => {
  const layer = solidLayer('1', 'Card', 200, 100, {
    anchor: vec(100, 50),
    position: vecKeys([
      { t: 0, v: { x: 100, y: 100 } },
      { t: 1, v: { x: 500, y: 300 }, e: EASE },
      { t: 2, v: { x: 500, y: 100 } },
    ]),
    rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 180, e: OVERSHOOT }] },
    scale: vecKeys([
      { t: 0.5, v: { x: 1, y: 1 } },
      { t: 1.5, v: { x: 2, y: 0.5 }, e: EASE },
    ]),
  });
  const comp = compOf('root', [layer]);
  const { root, out } = build(docOf([comp]));
  const node = assertSolidFollows(root, comp, layer);
  assert.equal(node.parent, root, 'no wrapper frame is needed');
  assert.deepEqual([...node.tracks.keys()].sort(), ['ROTATION', 'SCALE_XY', 'TRANSLATION_XY']);
  assert.equal(out.motion.problems.length, 0);
});

test('anchor in a corner: a pivot frame keeps rotation and scale around the anchor', () => {
  const layer = solidLayer('1', 'Door', 200, 100, {
    anchor: vec(0, 0),
    position: vec(300, 200),
    rotation: { v: 0, k: [{ t: 0, v: -30 }, { t: 2, v: 90, e: EASE }] },
    scale: vec(1.5, 0.5),
  });
  const comp = compOf('root', [layer]);
  const { root } = build(docOf([comp]));
  const node = assertSolidFollows(root, comp, layer);
  assert.equal(node.parent?.type, 'FRAME');
  assert.equal(node.parent?.parent, root);
});

test('separate X and Y position animate independently', () => {
  const layer = solidLayer('1', 'Ball', 60, 60, {
    anchor: vec(30, 30),
    position: {
      mode: 'split',
      x: { v: 0, k: [{ t: 0, v: 50 }, { t: 2, v: 700 }] },
      y: { v: 0, k: [{ t: 0, v: 100 }, { t: 0.7, v: 500, e: EASE }, { t: 1.4, v: 100, e: EASE }] },
    },
  });
  const comp = compOf('root', [layer]);
  const { root } = build(docOf([comp]));
  const node = assertSolidFollows(root, comp, layer);
  assert.deepEqual([...node.tracks.keys()].sort(), ['TRANSLATION_X', 'TRANSLATION_Y']);
});

test('a fixed even scale is baked into the size; a fixed rotation rests on the node', () => {
  const scaled = solidLayer('1', 'Photo', 400, 200, {
    anchor: vec(0, 0),
    scale: vec(0.5, 0.5),
    position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 1, v: { x: 300, y: 80 }, e: EASE }]),
  });
  const turned = solidLayer('2', 'Label', 120, 40, { anchor: vec(10, 30), position: vec(400, 300), rotation: { v: 30 } });
  const comp = compOf('root', [scaled, turned]);
  const { root } = build(docOf([comp]));
  const photo = assertSolidFollows(root, comp, scaled);
  assert.equal(photo.width, 200);
  assert.equal(photo.parent, root);
  const label = assertSolidFollows(root, comp, turned);
  assert.equal(label.tracks.size, 0, 'a still layer gets no tracks');
  assert.equal(label.parent, root);
});

test('a parent next to its children becomes a frame that holds them', () => {
  const ctrl: Layer = {
    id: '1',
    name: 'CTRL',
    transform: {
      anchor: vec(0, 0),
      position: vecKeys([{ t: 0, v: { x: 200, y: 150 } }, { t: 1.5, v: { x: 600, y: 400 }, e: EASE }]),
      scale: vecKeys([{ t: 0, v: { x: 1, y: 1 } }, { t: 2, v: { x: 0.5, y: 0.5 } }]),
      rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 120, e: EASE }] },
      opacity: { v: 0.2 },
    },
    content: { type: 'empty', width: 100, height: 100 },
    inPoint: 0,
    outPoint: 100,
  };
  const a = solidLayer('2', 'ChildA', 80, 80, {
    anchor: vec(40, 40),
    position: vec(50, 20),
    rotation: { v: 0, k: [{ t: 0.2, v: 0 }, { t: 1.2, v: -90 }] },
  }, { parentId: '1' });
  const b = solidLayer('3', 'ChildB', 100, 30, {
    anchor: vec(10, 10),
    position: vec(-60, 90),
    scale: vecKeys([{ t: 0, v: { x: 1, y: 1 } }, { t: 1, v: { x: 2, y: 2 }, e: EASE }]),
  }, { parentId: '1' });
  const comp = compOf('root', [ctrl, a, b]);
  const { root } = build(docOf([comp]));
  const rig = findNode(root, 'CTRL', 'FRAME');
  assert.ok(rig);
  const nodeA = assertSolidFollows(root, comp, a);
  const nodeB = assertSolidFollows(root, comp, b);
  assert.equal(nodeA.parent, rig, 'ChildA sits directly in the rig');
  assert.equal(nodeB.parent?.parent, rig, 'ChildB needs its own pivot frame inside the rig');
  assert.deepEqual(paintOrder(root, ['RECTANGLE']), ['ChildB', 'ChildA']);
});

test('a parent separated from its child keeps the stacking order and copies its motion', () => {
  const ctrl = solidLayer('1', 'Lead', 50, 50, {
    anchor: vec(25, 25),
    position: vecKeys([{ t: 0, v: { x: 100, y: 100 } }, { t: 2, v: { x: 500, y: 300 }, e: EASE }]),
    rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 200 }] },
    opacity: { v: 0.5 },
  });
  const other = solidLayer('2', 'Other', 300, 300, { position: vec(100, 100) });
  const kid = solidLayer('3', 'Kid', 90, 40, { anchor: vec(45, 20), position: vec(120, 0), rotation: { v: 15 } }, { parentId: '1' });
  const comp = compOf('root', [ctrl, other, kid]);
  const { root } = build(docOf([comp]));
  assertSolidFollows(root, comp, ctrl);
  assertSolidFollows(root, comp, other);
  const kidNode = assertSolidFollows(root, comp, kid);
  assert.deepEqual(paintOrder(root, ['RECTANGLE']), ['Kid', 'Other', 'Lead'], 'back to front, as in After Effects');
  assert.equal(worldOpacity(kidNode, root, 1), 1, "the parent's opacity is not inherited");
});

test('rotations past half a turn, whole turns and negative ones arrive as keyed, along a limb chain too', () => {
  // A limb chain nested as rigs (each child next to its parent)...
  const shoulder = solidLayer('1', 'Shoulder', 40, 40, {
    anchor: vec(20, 20),
    position: vec(400, 300),
    rotation: { v: -30, k: [{ t: 0, v: -30 }, { t: 0.8, v: 200, e: EASE }, { t: 1.4, v: 400, e: EASE }, { t: 2, v: -200, e: OVERSHOOT }] },
  });
  const arm = solidLayer('2', 'Arm', 140, 20, {
    anchor: vec(10, 10),
    position: vec(20, 20),
    rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: -540, e: EASE }, { t: 2, v: 190 }] },
  }, { parentId: '1' });
  const hand = solidLayer('3', 'Hand', 50, 30, {
    anchor: vec(10, 15),
    position: vec(130, 10),
    rotation: { v: 270, k: [{ t: 0, v: 270 }, { t: 1, v: 170, e: EASE }, { t: 2, v: 365 }] },
  }, { parentId: '2' });
  // ...and the same chain with a layer in between, so each child copies its parents' motion (ghost frames).
  const shoulderB = { ...shoulder, id: '11', name: 'ShoulderB' };
  const cover = solidLayer('12', 'Cover', 60, 60, { position: vec(50, 50) });
  const armB = { ...arm, id: '13', name: 'ArmB', parentId: '11' };
  const handB = { ...hand, id: '14', name: 'HandB', parentId: '13' };
  // Fixed rotations beyond half a turn: one resting on a node that moves, one on a still node.
  const tag = solidLayer('21', 'Tag', 80, 30, {
    anchor: vec(0, 0),
    position: vecKeys([{ t: 0, v: { x: 100, y: 500 } }, { t: 2, v: { x: 300, y: 450 }, e: EASE }]),
    rotation: { v: 370 },
  });
  const sticker = solidLayer('22', 'Sticker', 80, 30, { anchor: vec(5, 5), position: vec(650, 120), rotation: { v: -200 } });
  const spinner = solidLayer('23', 'Spinner', 60, 60, { anchor: vec(30, 30), position: vec(700, 500), rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: -720, e: EASE }] } });
  const layers = [hand, arm, shoulder, handB, cover, armB, shoulderB, tag, sticker, spinner];
  const comp = compOf('root', layers);
  const { root, out } = build(docOf([comp], 1));
  for (const l of layers) assertSolidFollows(root, comp, l);
  const ancestors: string[] = [];
  for (let n = findNode(root, 'HandB', 'RECTANGLE')!.parent; n && n !== root; n = n.parent) ancestors.push(n.name);
  assert.ok(ancestors.includes('ShoulderB › HandB') && ancestors.includes('ArmB › HandB'), `the second chain is built with ghost frames (${ancestors.join(' < ')})`);
  assert.equal(out.motion.problems.length, 0);

  // Every rotation track is minus the keys of one After Effects layer, value for value: never a turn added or lost.
  const keyed = layers.filter((l) => l.transform.rotation.k).map((l) => l.transform.rotation.k!.map((k) => k.v).join(' '));
  const tracked = root.findAll((n) => n.tracks.has('ROTATION'));
  assert.ok(tracked.length >= 9);
  for (const n of tracked) {
    const values = n.tracks.get('ROTATION')!.map((f) => -(f.value.value as number));
    if (values.length > 1) assert.ok(keyed.includes(values.join(' ')), `"${n.name}" turns ${values.join(' ')}`);
    // A node with a rotation track rests upright, so Figma has no resting rotation to combine with it.
    const [[, c], [b]] = n.relativeTransform;
    assert.ok(Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9, `"${n.name}" rests upright`);
  }
  // The tag's pivot frame carries the fixed rotation as written, past a whole turn.
  assert.deepEqual(findNode(root, 'Tag', 'FRAME')!.tracks.get('ROTATION')!.map((f) => f.value.value), [-370]);
});

test("a rig's own picture keeps its place between nested children", () => {
  // Stack: A (front), P, B (back). A is P's child, B is A's child.
  const a = solidLayer('1', 'A', 40, 40, { position: vec(10, 10) }, { parentId: '2' });
  const p = solidLayer('2', 'P', 200, 200, {
    anchor: vec(100, 100),
    position: vec(400, 300),
    rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 90 }] },
  });
  const b = solidLayer('3', 'B', 60, 60, { position: vec(30, 30) }, { parentId: '1' });
  const comp = compOf('root', [a, p, b]);
  const { root } = build(docOf([comp]));
  assertSolidFollows(root, comp, a);
  assertSolidFollows(root, comp, p);
  assertSolidFollows(root, comp, b);
  assert.deepEqual(paintOrder(root, ['RECTANGLE']), ['B', 'P', 'A']);
});

test('in and out points are written into the opacity', () => {
  const layer = solidLayer(
    '1',
    'Flash',
    100,
    100,
    {
      anchor: vec(50, 50),
      position: vec(400, 300),
      opacity: { v: 1, k: [{ t: 0.2, v: 0 }, { t: 1.0, v: 1, e: EASE }, { t: 1.8, v: 0.2 }] },
    },
    { inPoint: 0.5, outPoint: 1.5 },
  );
  const steady = solidLayer('2', 'Late', 100, 100, { opacity: { v: 0.6 } }, { inPoint: 1.25, outPoint: 100 });
  const never = solidLayer('3', 'Gone', 100, 100, {}, { inPoint: 5, outPoint: 9 });
  const comp = compOf('root', [layer, steady, never]);
  const { root, out } = build(docOf([comp]));
  assertSolidFollows(root, comp, layer);
  assertSolidFollows(root, comp, steady);
  assert.equal(findNode(root, 'Gone'), undefined, 'a layer that never shows is left out');
  assert.equal(out.motion.problems.length, 0);
});

test('nested compositions are shifted onto the main timeline and clipped', () => {
  const inner = compOf(
    'inner',
    [
      solidLayer(
        '1',
        'InnerBox',
        100,
        100,
        {
          anchor: vec(50, 50),
          position: vecKeys([{ t: 0, v: { x: 50, y: 50 } }, { t: 1, v: { x: 350, y: 250 }, e: EASE }]),
          rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 360 }] },
        },
        { inPoint: 0, outPoint: 1.5 },
      ),
    ],
    2,
    400,
    300,
  );
  const pre: Layer = {
    id: '1',
    name: 'Pre',
    transform: {
      anchor: vec(200, 150),
      position: vec(400, 300),
      scale: vec(0.5, 0.5),
      rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 3, v: 45, e: EASE }] },
      opacity: { v: 1 },
    },
    content: { type: 'comp', compId: 'inner', width: 400, height: 300, startTime: 0.5 },
    inPoint: 0.5,
    outPoint: 2.5,
  };
  const comp = compOf('root', [pre], 3);
  const { root, mock } = build(docOf([comp, inner]));
  const box = inner.layers[0]!;
  assertFollows(
    root,
    findNode(root, 'InnerBox', 'RECTANGLE'),
    3,
    (t) => mul(layerMatrix(comp, pre, t), layerMatrix(inner, box, t - 0.5)),
    () => ({ x: 0, y: 0, w: 100, h: 100 }),
    (t) => layerOpacity(pre, t) * layerOpacity(box, t - 0.5),
  );
  const frame = findNode(root, 'Pre', 'FRAME');
  assert.equal(frame?.clipsContent, true);
  assert.equal(mock.timelineDuration, 3);
});

test('an animated anchor point slides the content under a fixed pivot', () => {
  const layer = solidLayer('1', 'Slider', 200, 100, {
    anchor: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 2, v: { x: 100, y: 50 }, e: EASE }]),
    position: vec(400, 300),
    rotation: { v: 30 },
    scale: vec(1, 1),
  });
  const comp = compOf('root', [layer]);
  const { root } = build(docOf([comp]));
  assertSolidFollows(root, comp, layer);
});

function shapeDoc(): { comp: Comp; layer: Layer } {
  const layer: Layer = {
    id: '1',
    name: 'Shape',
    transform: {
      anchor: vec(0, 0),
      position: vec(400, 300),
      scale: vec(1, 1),
      rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 90, e: EASE }] },
      opacity: { v: 1 },
    },
    content: {
      type: 'group',
      children: [
        {
          name: 'Rectangle 1',
          transform: { anchor: vec(0, 0), position: vec(20, 10), scale: vec(1, 1), rotation: { v: 0 }, opacity: { v: 1 } },
          content: {
            type: 'rect',
            size: vecKeys([{ t: 0, v: { x: 100, y: 60 } }, { t: 1, v: { x: 300, y: 60 }, e: EASE }, { t: 2, v: { x: 300, y: 200 } }]),
            radius: { v: 8 },
            style: {
              fills: [{ color: { v: { r: 1, g: 0, b: 0, a: 1 }, k: [{ t: 0, v: { r: 1, g: 0, b: 0, a: 1 } }, { t: 2, v: { r: 0, g: 0, b: 1, a: 0.5 } }] } }],
              strokes: [],
            },
          },
        },
      ],
    },
    inPoint: 0,
    outPoint: 100,
  };
  return { comp: compOf('root', [layer]), layer };
}

function assertShapeFollows(root: MockNode, comp: Comp, layer: Layer): MockNode {
  const node = findNode(root, 'Shape', 'RECTANGLE');
  const rect = layer.content.type === 'group' ? layer.content.children[0]!.content : null;
  assert.ok(rect && rect.type === 'rect' && rect.size.mode === 'vec');
  const keys = rect.size.a.k!;
  const sizeAt = (t: number): Vec2 => {
    // Size keys in this test ease like the tracks written from them.
    const sim = { x: 0, y: 0 };
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i]!.t || i === keys.length - 1) {
        const a = keys[i - 1]!;
        const b = keys[i]!;
        const p = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
        const q = b.e && b.e.type === 'bezier' ? easeOf(b.e, p) : p;
        sim.x = a.v.x + (b.v.x - a.v.x) * q;
        sim.y = a.v.y + (b.v.y - a.v.y) * q;
        break;
      }
    }
    return sim;
  };
  assertFollows(
    root,
    node,
    comp.duration,
    (t) => mul(layerMatrix(comp, layer, t), translate(20, 10)),
    (t) => {
      const s = sizeAt(t);
      return { x: -s.x / 2, y: -s.y / 2, w: s.x, h: s.y };
    },
  );
  return node!;
}

import { easeProgress } from '../shared/anim.ts';
const easeOf = (e: Ease, p: number): number => easeProgress(e, p);

test('a rectangle that changes size grows from its centre, inside a turning layer', () => {
  const { comp, layer } = shapeDoc();
  const { root, out } = build(docOf([comp]));
  const node = assertShapeFollows(root, comp, layer);
  assert.ok(node.tracks.has('WIDTH') && node.tracks.has('HEIGHT') && node.tracks.has('fills[0]'));
  assert.equal(node.cornerRadius, 8);
  assert.equal(out.motion.problems.length, 0);
});

test('when Figma refuses a track, the builder falls back without losing the motion', () => {
  const { comp, layer } = shapeDoc();
  const sized = build(docOf([comp]), (mock) => mock.rejectFields.add('WIDTH').add('HEIGHT'));
  const node = assertShapeFollows(sized.root, comp, layer);
  assert.ok(node.tracks.has('SCALE_X') && node.tracks.has('SCALE_Y'), 'size falls back to scale');
  assert.equal(sized.out.motion.problems.length, 0);

  const card = solidLayer('1', 'Card', 200, 100, {
    anchor: vec(100, 50),
    position: vecKeys([{ t: 0, v: { x: 100, y: 100 } }, { t: 2, v: { x: 500, y: 300 }, e: EASE }]),
    scale: vecKeys([{ t: 0, v: { x: 1, y: 1 } }, { t: 2, v: { x: 2, y: 3 } }]),
  });
  const comp2 = compOf('root', [card]);
  const split = build(docOf([comp2]), (mock) => mock.rejectFields.add('TRANSLATION_XY').add('SCALE_XY'));
  const cardNode = assertSolidFollows(split.root, comp2, card);
  assert.deepEqual([...cardNode.tracks.keys()].sort(), ['SCALE_X', 'SCALE_Y', 'TRANSLATION_X', 'TRANSLATION_Y']);
});

test('without Figma Motion the static design is still built', () => {
  const layer = solidLayer('1', 'Card', 200, 100, {
    anchor: vec(100, 50),
    position: vecKeys([{ t: 0, v: { x: 100, y: 100 } }, { t: 2, v: { x: 500, y: 300 } }]),
    rotation: { v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 90 }] },
  });
  const comp = compOf('root', [layer]);
  const { root, out } = build(docOf([comp], 0), (mock) => {
    mock.motionEnabled = false;
  });
  assert.equal(out.motion.available, false);
  assert.equal(out.motion.tracks, 0);
  const node = findNode(root, 'Card', 'RECTANGLE');
  assert.ok(node);
  assertPoint(apply(worldMatrix(node, root, 0), { x: 100, y: 50 }), { x: 100, y: 100 }, 'resting centre');
});

test('the static design shows the poster frame', () => {
  const layer = solidLayer('1', 'Card', 200, 100, {
    anchor: vec(100, 50),
    position: vecKeys([{ t: 0, v: { x: 100, y: 100 } }, { t: 2, v: { x: 500, y: 300 } }]),
    opacity: { v: 1, k: [{ t: 0, v: 0 }, { t: 2, v: 1 }] },
  });
  const comp = compOf('root', [layer]);
  const { root } = build(docOf([comp], 1));
  const node = findNode(root, 'Card', 'RECTANGLE')!;
  assert.equal(node.x, 200);
  assert.equal(node.y, 150);
  assert.equal(node.opacity, 0.5);
});

test('text is placed on its baseline and vector outlines keep their place', () => {
  const text: Layer = {
    id: '1',
    name: 'Title',
    transform: { anchor: vec(0, 0), position: vec(400, 300), scale: vec(1, 1), rotation: { v: 0 }, opacity: { v: 1 } },
    content: {
      type: 'text',
      text: 'Hello\nWorld',
      fontFamily: 'Inter',
      fontStyle: 'Bold',
      fontSize: 40,
      fill: { r: 1, g: 1, b: 1, a: 1 },
      align: 'center',
      tracking: 50,
      lineHeight: 48,
      firstBaseline: { x: 0, y: 0 },
    },
    inPoint: 0,
    outPoint: 100,
  };
  const triangle: Layer = {
    id: '2',
    name: 'Tri',
    transform: { anchor: vec(0, 0), position: vec(100, 100), scale: vec(1, 1), rotation: { v: 0 }, opacity: { v: 1 } },
    content: {
      type: 'group',
      children: [
        {
          name: 'Path 1',
          transform: { anchor: vec(0, 0), position: vec(0, 0), scale: vec(1, 1), rotation: { v: 0 }, opacity: { v: 1 } },
          content: {
            type: 'path',
            paths: [{ closed: true, v: [{ x: -50, y: 40 }, { x: 0, y: -60 }, { x: 50, y: 40 }], i: [], o: [] }],
            style: {
              fills: [],
              strokes: [{ color: { v: { r: 0, g: 1, b: 0, a: 1 } } }],
              strokeWidth: { v: 4 },
              cap: 'round',
              trim: { start: { v: 0 }, end: { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 1, e: EASE }] }, offset: { v: 0 } },
            },
          },
        },
      ],
    },
    inPoint: 0,
    outPoint: 100,
  };
  const comp = compOf('root', [text, triangle]);
  const { root, out } = build(docOf([comp]));

  const title = findNode(root, 'Title', 'TEXT')!;
  assert.equal(title.characters, 'Hello\nWorld');
  assert.equal(title.leadingTrim, 'CAP_HEIGHT');
  // The mock's cap height is 0.7 em: the first baseline sits that far below the top.
  assert.ok(Math.abs(title.y + 40 * 0.7 - 300) < 1e-6, 'first baseline on the layer origin');
  assert.ok(Math.abs(title.x + title.width / 2 - 400) < 1e-6, 'centred on the layer origin');

  const tri = findNode(root, 'Tri', 'VECTOR')!;
  assert.equal(tri.vectorPaths[0]!.data, 'M 0 100 L 50 0 L 100 100 L 0 100 Z');
  assert.equal(tri.x, 50);
  assert.equal(tri.y, 40);
  assert.equal(tri.strokeWeight, 4);
  assert.ok(tri.tracks.has('PATH_TRIM_END') && !tri.tracks.has('PATH_TRIM_START'));
  assert.equal(out.motion.problems.length, 0);
});
