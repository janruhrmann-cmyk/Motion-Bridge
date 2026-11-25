/** Outline helpers: building primitive outlines, measuring them, writing SVG path data. */
import type { Rect, SubPath, Vec2 } from './format.ts';

const KAPPA = 0.5522847498;

const pt = (x: number, y: number): Vec2 => ({ x, y });

export function rectSubPath(cx: number, cy: number, w: number, h: number, radius: number): SubPath {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (r < 1e-6) {
    const v = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
    return { closed: true, v, i: v.map(() => pt(0, 0)), o: v.map(() => pt(0, 0)) };
  }
  const k = r * KAPPA;
  return {
    closed: true,
    v: [
      pt(x0 + r, y0),
      pt(x1 - r, y0),
      pt(x1, y0 + r),
      pt(x1, y1 - r),
      pt(x1 - r, y1),
      pt(x0 + r, y1),
      pt(x0, y1 - r),
      pt(x0, y0 + r),
    ],
    i: [pt(-k, 0), pt(0, 0), pt(0, -k), pt(0, 0), pt(k, 0), pt(0, 0), pt(0, k), pt(0, 0)],
    o: [pt(0, 0), pt(k, 0), pt(0, 0), pt(0, k), pt(0, 0), pt(-k, 0), pt(0, 0), pt(0, -k)],
  };
}

export function ellipseSubPath(cx: number, cy: number, w: number, h: number): SubPath {
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    closed: true,
    v: [pt(cx, cy - ry), pt(cx + rx, cy), pt(cx, cy + ry), pt(cx - rx, cy)],
    i: [pt(-kx, 0), pt(0, -ky), pt(kx, 0), pt(0, ky)],
    o: [pt(kx, 0), pt(0, ky), pt(-kx, 0), pt(0, -ky)],
  };
}

export function starSubPath(opts: {
  polygon: boolean;
  points: number;
  cx: number;
  cy: number;
  rotation: number;
  outerRadius: number;
  innerRadius: number;
}): SubPath {
  const n = Math.max(3, Math.round(opts.points));
  const count = opts.polygon ? n : n * 2;
  const v: Vec2[] = [];
  for (let idx = 0; idx < count; idx++) {
    const radius = opts.polygon || idx % 2 === 0 ? opts.outerRadius : opts.innerRadius;
    const angle = ((-90 + opts.rotation + (idx * 360) / count) * Math.PI) / 180;
    v.push(pt(opts.cx + Math.cos(angle) * radius, opts.cy + Math.sin(angle) * radius));
  }
  return { closed: true, v, i: v.map(() => pt(0, 0)), o: v.map(() => pt(0, 0)) };
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const it = 1 - t;
  return it * it * it * p0 + 3 * it * it * t * p1 + 3 * it * t * t * p2 + t * t * t * p3;
}

/** Parameters in (0,1) at which one coordinate of a cubic reaches an extreme. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

interface Segment {
  p0: Vec2;
  c1: Vec2;
  c2: Vec2;
  p1: Vec2;
  straight: boolean;
}

function segments(sp: SubPath): Segment[] {
  const out: Segment[] = [];
  const n = sp.v.length;
  const last = sp.closed ? n : n - 1;
  for (let j = 0; j < last; j++) {
    const a = j;
    const b = (j + 1) % n;
    const p0 = sp.v[a]!;
    const p1 = sp.v[b]!;
    const o = sp.o[a] ?? pt(0, 0);
    const i = sp.i[b] ?? pt(0, 0);
    const straight = Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6 && Math.abs(i.x) < 1e-6 && Math.abs(i.y) < 1e-6;
    out.push({ p0, c1: pt(p0.x + o.x, p0.y + o.y), c2: pt(p1.x + i.x, p1.y + i.y), p1, straight });
  }
  return out;
}

export function pathsBounds(paths: SubPath[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const sp of paths) {
    for (const v of sp.v) add(v.x, v.y);
    for (const s of segments(sp)) {
      if (s.straight) continue;
      for (const t of cubicExtrema(s.p0.x, s.c1.x, s.c2.x, s.p1.x)) {
        add(cubicAt(s.p0.x, s.c1.x, s.c2.x, s.p1.x, t), cubicAt(s.p0.y, s.c1.y, s.c2.y, s.p1.y, t));
      }
      for (const t of cubicExtrema(s.p0.y, s.c1.y, s.c2.y, s.p1.y)) {
        add(cubicAt(s.p0.x, s.c1.x, s.c2.x, s.p1.x, t), cubicAt(s.p0.y, s.c1.y, s.c2.y, s.p1.y, t));
      }
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const num = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** SVG path data for one outline, moved by (dx, dy). */
export function subPathToSvg(sp: SubPath, dx: number, dy: number): string {
  if (!sp.v.length) return '';
  const first = sp.v[0]!;
  const parts: string[] = [`M ${num(first.x + dx)} ${num(first.y + dy)}`];
  for (const s of segments(sp)) {
    if (s.straight) {
      parts.push(`L ${num(s.p1.x + dx)} ${num(s.p1.y + dy)}`);
    } else {
      parts.push(
        `C ${num(s.c1.x + dx)} ${num(s.c1.y + dy)} ${num(s.c2.x + dx)} ${num(s.c2.y + dy)} ${num(s.p1.x + dx)} ${num(s.p1.y + dy)}`,
      );
    }
  }
  if (sp.closed) parts.push('Z');
  return parts.join(' ');
}

/** Twice the enclosed area of the outline's corner points; the sign tells which way round it runs. */
export function signedArea(sp: SubPath): number {
  let a = 0;
  for (let j = 0; j < sp.v.length; j++) {
    const p = sp.v[j]!;
    const q = sp.v[(j + 1) % sp.v.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** The same outline, drawn the other way round. */
export function reversed(sp: SubPath): SubPath {
  const n = sp.v.length;
  const pick = (list: Vec2[], j: number): Vec2 => list[n - 1 - j] ?? pt(0, 0);
  return {
    closed: sp.closed,
    v: sp.v.map((_, j) => pick(sp.v, j)),
    i: sp.v.map((_, j) => pick(sp.o, j)),
    o: sp.v.map((_, j) => pick(sp.i, j)),
  };
}

/**
 * An outline as a fill needs it: closed. After Effects fills open outlines as
 * if they were closed, and vector artwork often arrives "open" with its last
 * point sitting on its first. `keepGaps` leaves a real gap alone (for a
 * stroked outline, closing it would draw a line that is not there).
 */
export function closedForFill(sp: SubPath, keepGaps: boolean): SubPath {
  const n = sp.v.length;
  if (sp.closed || n < 3) return sp;
  const first = sp.v[0]!;
  const last = sp.v[n - 1]!;
  if (Math.hypot(first.x - last.x, first.y - last.y) < 0.01) {
    // Ends where it starts: the doubled point goes, its incoming handle moves to the first point.
    const i = sp.i.slice(0, n - 1);
    i[0] = sp.i[n - 1] ?? pt(0, 0);
    return { closed: true, v: sp.v.slice(0, n - 1), i, o: sp.o.slice(0, n - 1) };
  }
  if (keepGaps) return sp;
  const i = sp.i.slice();
  const o = sp.o.slice();
  i[0] = pt(0, 0);
  o[n - 1] = pt(0, 0);
  return { closed: true, v: sp.v, i, o };
}

/**
 * SVG path data for several outlines as ONE compound path. Only then does
 * the winding rule let one outline cut a hole into another (the counter of
 * an "o", the inside of a ring).
 */
export function compoundSvg(paths: SubPath[], dx: number, dy: number): string {
  return paths
    .filter((sp) => sp.v.length > 0)
    .map((sp) => subPathToSvg(sp, dx, dy))
    .join(' ');
}

export function unionRects(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Rotates a vector by `degrees`, clockwise on screen (y down). */
export function rotate(v: Vec2, degrees: number): Vec2 {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A rectangle centred on (cx, cy) with a radius of its own per corner: top-left, top-right, bottom-right, bottom-left. */
export function cornersSubPath(cx: number, cy: number, w: number, h: number, radii: [number, number, number, number]): SubPath {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const limit = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, limit))) as [number, number, number, number];
  const v: Vec2[] = [];
  const i: Vec2[] = [];
  const o: Vec2[] = [];
  /** One corner: where the outline arrives, where it leaves, and the directions it does so in. */
  const corner = (r: number, ax: number, ay: number, bx: number, by: number, dirIn: Vec2, dirOut: Vec2): void => {
    if (r < 1e-6) {
      v.push(pt(ax, ay));
      i.push(pt(0, 0));
      o.push(pt(0, 0));
      return;
    }
    const k = r * KAPPA;
    v.push(pt(ax, ay), pt(bx, by));
    i.push(pt(0, 0), pt(-dirOut.x * k, -dirOut.y * k));
    o.push(pt(dirIn.x * k, dirIn.y * k), pt(0, 0));
  };
  // Clockwise from the top edge.
  corner(tr, x1 - tr, y0, x1, y0 + tr, pt(1, 0), pt(0, 1));
  corner(br, x1, y1 - br, x1 - br, y1, pt(0, 1), pt(-1, 0));
  corner(bl, x0 + bl, y1, x0, y1 - bl, pt(-1, 0), pt(0, -1));
  corner(tl, x0, y0 + tl, x0 + tl, y0, pt(0, -1), pt(1, 0));
  return { closed: true, v, i, o };
}

/**
 * Reads SVG path data (as Figma writes it for a vector: M, L, C, Q and Z,
 * upper or lower case, plus H and V) into outlines.
 */
export function svgToSubPaths(data: string): SubPath[] {
  const tokens = data.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let current: SubPath | null = null;
  let x = 0;
  let y = 0;
  let at = 0;
  let command = '';

  const close = (sp: SubPath): void => {
    sp.closed = true;
    const n = sp.v.length;
    if (n < 2) return;
    const first = sp.v[0]!;
    const last = sp.v[n - 1]!;
    // "Z" after a segment that already returned to the start: the doubled point goes.
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) {
      sp.i[0] = sp.i[n - 1]!;
      sp.v.pop();
      sp.i.pop();
      sp.o.pop();
    }
  };
  const finish = (): void => {
    if (current && current.v.length) out.push(current);
    current = null;
  };
  const start = (px: number, py: number): SubPath => {
    finish();
    current = { closed: false, v: [pt(px, py)], i: [pt(0, 0)], o: [pt(0, 0)] };
    return current;
  };
  const open = (): SubPath => current ?? start(x, y);
  const next = (): number => {
    const n = Number(tokens[at++]);
    return isFinite(n) ? n : 0;
  };
  const more = (): boolean => at < tokens.length && !/^[a-zA-Z]$/.test(tokens[at]!);
  const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, px: number, py: number): void => {
    const sp = open();
    sp.o[sp.o.length - 1] = pt(c1x - x, c1y - y);
    sp.v.push(pt(px, py));
    sp.i.push(pt(c2x - px, c2y - py));
    sp.o.push(pt(0, 0));
    x = px;
    y = py;
  };
  const line = (px: number, py: number): void => {
    const sp = open();
    sp.v.push(pt(px, py));
    sp.i.push(pt(0, 0));
    sp.o.push(pt(0, 0));
    x = px;
    y = py;
  };

  while (at < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[at]!)) command = tokens[at++]!;
    else if (!command) {
      at++;
      continue;
    }
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (command.toUpperCase()) {
      case 'M': {
        x = ox + next();
        y = oy + next();
        start(x, y);
        // Further pairs after a move are lines.
        command = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        line(ox + next(), oy + next());
        break;
      case 'H':
        line(ox + next(), y);
        break;
      case 'V':
        line(x, oy + next());
        break;
      case 'C': {
        const c1x = ox + next();
        const c1y = oy + next();
        const c2x = ox + next();
        const c2y = oy + next();
        cubic(c1x, c1y, c2x, c2y, ox + next(), oy + next());
        break;
      }
      case 'Q': {
        const qx = ox + next();
        const qy = oy + next();
        const px = ox + next();
        const py = oy + next();
        // The same curve as a cubic.
        cubic(x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3, px + ((qx - px) * 2) / 3, py + ((qy - py) * 2) / 3, px, py);
        break;
      }
      case 'Z': {
        const sp: SubPath | null = current;
        if (sp) {
          const first = (sp as SubPath).v[0]!;
          close(sp);
          x = first.x;
          y = first.y;
        }
        finish();
        command = '';
        break;
      }
      default:
        // Arcs and smooth curves are not something Figma writes; skip their numbers.
        while (more()) at++;
        command = '';
        break;
    }
  }
  finish();
  return out;
}

/** Whether the point lies inside a w x h box at the origin whose corners are rounded with `radius`. */
export function insideRounded(p: Vec2, w: number, h: number, radius: number, slack = 0.5): boolean {
  if (p.x < -slack || p.y < -slack || p.x > w + slack || p.y > h + slack) return false;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 1e-6) return true;
  const cx = p.x < r ? r : p.x > w - r ? w - r : p.x;
  const cy = p.y < r ? r : p.y > h - r ? h - r : p.y;
  return Math.hypot(p.x - cx, p.y - cy) <= r + slack;
}
