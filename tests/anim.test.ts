import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ease, Key } from '../shared/format.ts';
import { clipKeys, easeProgress, evalKeys, numOps, simplifySamples, splitEase, windowAnim } from '../shared/anim.ts';
import { pathsBounds, ellipseSubPath, rectSubPath, subPathToSvg } from '../shared/geometry.ts';

const near = (a: number, b: number, eps = 1e-4): void => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('bezier easing matches known values', () => {
  const easeInOut: Ease = { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
  near(easeProgress(easeInOut, 0), 0);
  near(easeProgress(easeInOut, 1), 1);
  near(easeProgress(easeInOut, 0.5), 0.5);
  assert.ok(easeProgress(easeInOut, 0.25) < 0.25);
  // A straight-line bezier is linear.
  near(easeProgress({ type: 'bezier', x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 }, 0.37), 0.37);
  // Overshoot is allowed.
  assert.ok(easeProgress({ type: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }, 0.6) > 1);
});

test('a piece of an ease reproduces the original curve', () => {
  const eases: Ease[] = [
    { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    { type: 'bezier', x1: 0.1, y1: 0.9, x2: 0.2, y2: 1 },
    { type: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
    { type: 'bezier', x1: 0.9, y1: 0, x2: 1, y2: 0.3 },
  ];
  for (const e of eases) {
    for (const [p0, p1] of [[0.2, 0.7], [0, 0.4], [0.55, 1], [0.31, 0.33]] as Array<[number, number]>) {
      const part = splitEase(e, p0, p1);
      const y0 = easeProgress(e, p0);
      const y1 = easeProgress(e, p1);
      for (let i = 0; i <= 10; i++) {
        const u = i / 10;
        near(y0 + (y1 - y0) * easeProgress(part, u), easeProgress(e, p0 + (p1 - p0) * u), 2e-4);
      }
    }
  }
});

test('cutting keys to a window leaves the motion inside it unchanged', () => {
  const keys: Key<number>[] = [
    { t: 0, v: 0 },
    { t: 1, v: 100, e: { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
    { t: 2, v: 40, e: { type: 'hold' } },
    { t: 3, v: -20 },
    { t: 4, v: 60, e: { type: 'bezier', x1: 0.2, y1: 0.8, x2: 0.3, y2: 1 } },
  ];
  for (const [t0, t1] of [[0.3, 3.6], [0, 4], [1, 2], [1.2, 1.8], [2.5, 2.9], [0.5, 10], [-5, 0.5]] as Array<[number, number]>) {
    const cut = clipKeys(keys, t0, t1, numOps);
    assert.ok(cut.length >= 1);
    assert.ok(cut[0]!.t >= t0 - 1e-9 && cut[cut.length - 1]!.t <= t1 + 1e-9, 'keys stay inside the window');
    for (let i = 0; i <= 40; i++) {
      // Stay a hair inside the window: a hold that steps exactly on the edge belongs to the next moment.
      const t = t0 + ((t1 - t0) * (i + 0.5)) / 41;
      near(evalKeys(cut, t, numOps), evalKeys(keys, t, numOps), 2e-2);
    }
  }
  // Entirely before or after: a single constant key.
  assert.deepEqual(clipKeys(keys, 10, 12, numOps), [{ t: 10, v: 60 }]);
  assert.deepEqual(clipKeys(keys, -4, -2, numOps), [{ t: -4, v: 0 }]);
});

test('windowAnim shifts, cuts and recognises a value that no longer moves', () => {
  const anim = { v: 5, k: [{ t: 0, v: 0 }, { t: 1, v: 10 }] as Key<number>[] };
  const shifted = windowAnim(anim, 2, 0, 10, numOps);
  assert.deepEqual(shifted.k!.map((k) => k.t), [2, 3]);
  assert.deepEqual(windowAnim(anim, -5, 0, 10, numOps), { v: 10 });
  assert.deepEqual(windowAnim({ v: 7 }, 3, 0, 10, numOps), { v: 7 });
});

test('samples are reduced to the keys that matter', () => {
  const times: number[] = [];
  const line: number[] = [];
  const bent: number[] = [];
  for (let i = 0; i <= 60; i++) {
    times.push(i / 30);
    line.push(i * 2);
    bent.push(i <= 30 ? i : 30 - (i - 30) * 0.5);
  }
  assert.equal(simplifySamples(times, line, numOps, 0.01).length, 2);
  const keys = simplifySamples(times, bent, numOps, 0.01);
  assert.deepEqual(keys.map((k) => k.t), [0, 1, 2]);
  assert.deepEqual(simplifySamples(times, times.map(() => 3), numOps, 0.01), []);

  const wave = times.map((t) => Math.sin(t * 4) * 50);
  const reduced = simplifySamples(times, wave, numOps, 2);
  assert.ok(reduced.length < wave.length / 2, 'a smooth curve needs far fewer keys than samples');
  for (let i = 0; i < times.length; i++) near(evalKeys(reduced, times[i]!, numOps), wave[i]!, 2 + 1e-9);
});

test('outline bounds include the bulge of curves', () => {
  const circle = pathsBounds([ellipseSubPath(10, 20, 100, 60)]);
  near(circle.x, -40, 1e-3);
  near(circle.y, -10, 1e-3);
  near(circle.w, 100, 1e-3);
  near(circle.h, 60, 1e-3);
  const rounded = pathsBounds([rectSubPath(0, 0, 80, 40, 12)]);
  near(rounded.w, 80, 1e-6);
  near(rounded.h, 40, 1e-6);
  const svg = subPathToSvg(rectSubPath(0, 0, 80, 40, 0), 40, 20);
  assert.equal(svg, 'M 0 0 L 80 0 L 80 40 L 0 40 L 0 0 Z');
});
