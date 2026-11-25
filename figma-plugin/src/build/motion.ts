/**
 * Writes keyframe tracks through Figma's Motion API (beta).
 *
 * What the API expects (from Figma's own reference):
 *  - Times are seconds on the top-level frame's timeline.
 *  - The easing on a key describes the trip from the previous key to it.
 *  - TRANSLATION adds to the node's resting position, SCALE multiplies its
 *    resting size, ROTATION adds to its resting rotation (counter-clockwise
 *    positive) - rotation and scale pivot on the node's centre.
 *  - OPACITY, sizes, radii, trims and colours replace the resting value.
 *
 * Every write is guarded: one rejected track is reported and the rest of the
 * build carries on. If Motion is not enabled for the account, tracks are
 * skipped and the static design is still built.
 */
import type { Ease, Key, RGBA, Vec2 } from '../../../shared/format.ts';

type FloatField = KeyframePropertyFieldName;

interface MotionTarget {
  name: string;
  applyManualKeyframeTrack?: (field: KeyframeField, track: ManualKeyframeTrackInput) => void;
}

function easing(e: Ease | undefined): MotionEasing {
  if (!e || e.type === 'linear') return { type: 'LINEAR' };
  if (e.type === 'hold') return { type: 'HOLD' };
  if (e.type === 'spring') {
    return { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: Math.max(0, Math.min(1, e.bounce)) } };
  }
  return {
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 },
  };
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

export class MotionWriter {
  /** null until the first write shows whether the Motion API is there. */
  available: boolean | null = null;
  tracks = 0;
  readonly problems: string[] = [];
  private readonly duration: number;

  constructor(duration: number) {
    this.duration = duration;
  }

  private frames<T>(keys: Key<T>[], value: (v: T) => KeyframeValue): ManualKeyframeInput[] {
    return keys.map((k, index) => {
      const frame: { timelinePosition: number; value: KeyframeValue; easing?: MotionEasing } = {
        timelinePosition: round(Math.max(0, k.t)),
        value: value(k.v),
      };
      // The first key has nothing to ease from.
      if (index > 0) frame.easing = easing(k.e);
      return frame;
    });
  }

  private write(node: MotionTarget, field: KeyframeField, keyframes: ManualKeyframeInput[], label: string): boolean {
    if (this.available === false) return false;
    if (typeof node.applyManualKeyframeTrack !== 'function') {
      this.available = false;
      return false;
    }
    const attempt = (frames: ManualKeyframeInput[]): string | null => {
      try {
        node.applyManualKeyframeTrack!(field, { keyframes: frames });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    let message = attempt(keyframes);
    if (message !== null && /not a supported api/i.test(message)) {
      this.available = false;
      return false;
    }
    if (message !== null && keyframes.length === 1) {
      // A constant value: some builds may want at least two keys per track.
      const only = keyframes[0]!;
      message = attempt([only, { timelinePosition: round(this.duration), value: only.value, easing: { type: 'LINEAR' } }]);
    }
    if (message !== null) {
      this.problems.push(`"${node.name}": ${label} was not accepted (${message})`);
      return false;
    }
    this.available = true;
    this.tracks++;
    return true;
  }

  float(node: MotionTarget, name: FloatField, keys: Key<number>[]): boolean {
    const value = (v: number): KeyframeValue => ({ type: 'FLOAT', value: round(v) });
    return this.write(node, { type: 'PROPERTY', name }, this.frames(keys, value), name);
  }

  /** A value that never changes but has to live on the timeline rather than on the node. */
  constant(node: MotionTarget, name: FloatField, value: number): boolean {
    return this.float(node, name, [{ t: 0, v: value }]);
  }

  /** Writes both axes as one track, or as two if the combined track is refused. */
  vector(
    node: MotionTarget,
    name: 'TRANSLATION_XY' | 'SCALE_XY',
    xName: FloatField,
    yName: FloatField,
    keys: Key<Vec2>[],
  ): boolean {
    const value = (v: Vec2): KeyframeValue => ({ type: 'VECTOR', value: { x: round(v.x), y: round(v.y) } });
    const problemsBefore = this.problems.length;
    if (this.write(node, { type: 'PROPERTY', name }, this.frames(keys, value), name)) return true;
    if (this.available === false) return false;
    this.problems.length = problemsBefore;
    const x = this.float(node, xName, keys.map((k) => ({ ...k, v: k.v.x })));
    const y = this.float(node, yName, keys.map((k) => ({ ...k, v: k.v.y })));
    return x && y;
  }

  color(node: MotionTarget, collection: 'fills' | 'strokes', index: number, keys: Key<RGBA>[]): boolean {
    const value = (v: RGBA): KeyframeValue => ({
      type: 'COLOR',
      value: { r: round(v.r), g: round(v.g), b: round(v.b), a: round(v.a) },
    });
    return this.write(node, { type: 'INDEXED_ITEM', collection, index }, this.frames(keys, value), `${collection} colour`);
  }
}
