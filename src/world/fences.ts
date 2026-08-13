/**
 * FENCES — a fence is a PATH turned into continuous chains of posts and bays,
 * one plank stretched per gap (issue #105 was fixed-length panels stamped blind).
 *
 * INVARIANT: every plank ends INSIDE the two posts it joins, at a height both
 * carry — `sz = gap / railLen` at the bay midpoint, `min(yA, yB) + railAt` with
 * `railAt < postH`. A bay over staircase terrain is LIFTED up to `maxRise`, then
 * refused, which ENDS the chain and starts a new one (hence a list): a field gate.
 * Guard: `tools/test-fence.mjs`.
 */
import type { Accum} from "./props";
import { type Template } from "./props";
import type { SolidStamp } from "./structures";

/**
 * The kit one fence is built from (`TownParts.fence`, or a second world's own).
 * The metrics are the CONTRACT: the post builder owns its height, not this file.
 */
export interface FenceParts {
  /** The plain stake, drawn from its base along +y. */
  readonly post: Template;
  readonly tall: Template;
  readonly lantern: Template;
  readonly lanternGlow: Template;
  /** One plank along +z, `railLen` long, carrying the fence's collider. */
  readonly rail: Template;
  readonly railProp: Template;
  /** Template length, i.e. what a bay's `sz` divides by. */
  readonly railLen: number;
  /** Must be under `postWidth`. */
  readonly railWidth: number;
  readonly railHeight: number;
  readonly postWidth: number;
  /** Plank BOTTOMS above the fence line, lowest first. Last one is the top. */
  readonly railAt: readonly number[];
  /** Must exceed each complete rail. */
  readonly postH: number;
  readonly tallH: number;
  readonly lanternH: number;
  readonly postR: number;
}

/** `y` is the line the fence is laid on. */
export interface FenceNode {
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

export type FencePostKind = "post" | "tall" | "lantern";

export interface FencePost {
  readonly x: number;
  readonly z: number;
  /** The fence line here — planks hang off this, the stake stands on it. */
  readonly y: number;
  readonly base: number;
  readonly yaw: number;
  readonly kind: FencePostKind;
}

export interface FenceBay {
  readonly from: number;
  readonly to: number;
  readonly length: number;
  readonly y: number;
  /** HIGHEST surface under the bay, sampled along it. `y` where no `groundAt`. */
  readonly groundMax: number;
}

/** `posts.length === bays.length + 1`, or `=== bays.length` on an intact ring. */
export interface Fence {
  readonly posts: readonly FencePost[];
  readonly bays: readonly FenceBay[];
  readonly closed: boolean;
}

export interface FenceOptions {
  readonly maxGap?: number;
  /** Shortest a bay may be, unless the whole path is shorter than one. */
  readonly minGap?: number;
  readonly closed?: boolean;
  readonly lanternEvery?: number;
  /** Every Nth post is a tall one. Lanterns win where the two coincide. */
  readonly tallEvery?: number;
  /** The surface under a post where the line is not it (a railing's is the deck). */
  readonly groundAt?: (x: number, z: number) => number;
  readonly maxDrop?: number;
  /** How far the lowest plank must clear the ground under its own bay. */
  readonly clearance?: number;
  /** Lift allowance over a rise; past it the bay is refused rather than flown. */
  readonly maxRise?: number;
  readonly foot?: number;
  /** Vetoes one bay's planks — see the note on gates at the top. */
  readonly accept?: (ax: number, az: number, bx: number, bz: number) => boolean;
  readonly glow?: Accum;
}

const DEFAULT_MAX_GAP = 3.2;
const DEFAULT_MIN_GAP = 1.6;
/** Covers a bridge abutment; a free leg stays behind `RIBBON_SKIRT` (1.1). */
const DEFAULT_MAX_DROP = 1.4;
const DEFAULT_FOOT = 0.35;
/** Just enough that a surface and a plank at the same height do not z-fight. */
const DEFAULT_CLEARANCE = 0.08;
/** Terrain is floored to whole units: clears one step, refuses a doubled terrace. */
const DEFAULT_MAX_RISE = 1.25;
/** 0.4 puts at least two samples in every 1-unit column a bay crosses. */
const RISE_STEP = 0.4;

/** `path` is a polyline of ARBITRARY spacing; this chooses where posts go. */
export function buildFence(
  solid: SolidStamp,
  parts: FenceParts,
  path: readonly FenceNode[],
  opts: FenceOptions = {},
): Fence[] {
  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP;
  const minGap = Math.min(opts.minGap ?? DEFAULT_MIN_GAP, maxGap);
  const foot = opts.foot ?? DEFAULT_FOOT;
  const maxDrop = opts.maxDrop ?? DEFAULT_MAX_DROP;
  const clearance = opts.clearance ?? DEFAULT_CLEARANCE;
  const maxRise = opts.maxRise ?? DEFAULT_MAX_RISE;
  const groundAt = opts.groundAt;

  const nodes = opts.closed && path.length > 2 ? [...path, path[0]] : path;
  if (nodes.length < 2) {
    return [];
  }

  const seg: number[] = [0];
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    total += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
    seg.push(total);
  }
  if (total < 1e-3) {
    return [];
  }

  // A division, not a walk: `ceil(len / maxGap)` EQUAL bays leave no stub, so the
  // end post lands exactly on the end of the path.
  let bays = Math.max(1, Math.ceil(total / maxGap));
  while (bays > 1 && total / bays < minGap) {
    bays--;
  }
  const gap = total / bays;

  const at = (s: number): FenceNode => {
    let i = 1;
    while (i < seg.length - 1 && seg[i] < s) {
      i++;
    }
    const span = seg[i] - seg[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (s - seg[i - 1]) / span));
    const a = nodes[i - 1];
    const b = nodes[i];
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      y: a.y + (b.y - a.y) * t,
    };
  };

  const ring = opts.closed && path.length > 2;
  const count = ring ? bays : bays + 1;
  const pts: FenceNode[] = [];
  for (let i = 0; i < count; i++) {
    pts.push(at(i * gap));
  }

  const posts: Array<{ -readonly [K in keyof FencePost]: FencePost[K] }> = [];
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    // Mean of the bays either side, so a corner post's fork bisects the corner.
    const prev = i > 0 ? pts[i - 1] : ring ? pts[count - 1] : null;
    const next = i < count - 1 ? pts[i + 1] : ring ? pts[0] : null;
    let dx = 0;
    let dz = 0;
    for (const [a, b] of [
      [prev, p],
      [p, next],
    ] as const) {
      if (!a || !b) {
        continue;
      }
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      dx += (b.x - a.x) / l;
      dz += (b.z - a.z) / l;
    }
    const yaw = Math.atan2(dx, dz);
    const every = (n: number | undefined): boolean => !!n && n > 0 && i % n === 0;
    const kind: FencePostKind =
      every(opts.lanternEvery) && opts.glow ? "lantern" : every(opts.tallEvery) ? "tall" : "post";
    // `base` is filled in at the end, once the line has stopped moving.
    posts.push({ x: p.x, z: p.z, y: p.y, base: p.y, yaw, kind });
  }

  // The caller's line is seated on the MINIMUM over a footprint, so it can sit a
  // unit under a post's column. Lifting only RAISES, so one pass is enough.
  const line0 = posts.map((p) => p.y);
  /** Highest walking surface on the segment a->b, endpoints included. */
  const ridgeUnder = (ax: number, az: number, bx: number, bz: number): number => {
    if (!groundAt) {
      return -Infinity;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / RISE_STEP));
    let hi = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = groundAt(ax + (bx - ax) * t, az + (bz - az) * t);
      if (g > hi) {
        hi = g;
      }
    }
    return hi;
  };
  const lift = (i: number, want: number): void => {
    if (want <= posts[i].y) {
      return;
    }
    posts[i].y = Math.min(want, line0[i] + maxRise);
  };
  if (groundAt) {
    for (let i = 0; i < posts.length; i++) {
      lift(i, groundAt(posts[i].x, posts[i].z));
    }
  }

  // Planks sit at the LOWER of the two lines, so the UPPER post's foot is pulled
  // down to the lowest plank it carries. Must run BEFORE anything is stamped.
  type Settling = FenceBay & { planked: boolean };
  const out: Settling[] = [];
  for (let i = 0; i < bays; i++) {
    const j = (i + 1) % posts.length;
    const a = posts[i];
    const b = posts[j];
    const groundMax = ridgeUnder(a.x, a.z, b.x, b.z);
    // Asked of both posts: a plank hangs off the lower of the two lines.
    if (groundMax > -Infinity) {
      const want = groundMax + clearance - parts.railAt[0];
      lift(i, want);
      lift(j, want);
    }
    out.push({
      from: i,
      to: j,
      length: Math.hypot(b.x - a.x, b.z - a.z),
      y: 0,
      groundMax: groundMax > -Infinity ? groundMax : 0,
      planked: false,
    });
  }

  for (let i = 0; i < out.length; i++) {
    const bay = out[i];
    const a = posts[bay.from];
    const b = posts[bay.to];
    // The LOWER of the two, so both stakes carry material at every plank height.
    const y = Math.min(a.y, b.y);
    // Lost to the caller's `accept`, or to a bottom plank still in the bank.
    const planked =
      (!opts.accept || opts.accept(a.x, a.z, b.x, b.z)) &&
      !(groundAt && y + parts.railAt[0] < bay.groundMax + clearance - 1e-6);
    out[i] = { ...bay, y, groundMax: groundAt ? bay.groundMax : y, planked };
    if (!planked) {
      continue;
    }
    const under = y + parts.railAt[0] - foot;
    if (under < a.base) {
      a.base = under;
    }
    if (under < b.base) {
      b.base = under;
    }
  }

  // A refused bay splits the run in two, keeping "posts = bays + 1" true. A post
  // survives only if a planked bay reaches it — no rows of lone stakes.
  const runs: Array<Array<{ bay: Settling; from: number; to: number }>> = [];
  let run: Array<{ bay: Settling; from: number; to: number }> = [];
  // Unroll a ring from AFTER a gap, so a chain is never cut where the path began.
  const first = ring ? Math.max(0, out.findIndex((b) => !b.planked) + 1) : 0;
  for (let k = 0; k < out.length; k++) {
    const bay = out[(first + k) % out.length];
    if (!bay.planked) {
      if (run.length > 0) {
        runs.push(run);
      }
      run = [];
      continue;
    }
    run.push({ bay, from: bay.from, to: bay.to });
  }
  if (run.length > 0) {
    runs.push(run);
  }
  if (runs.length === 0) {
    return [];
  }

  const fences: Fence[] = [];
  const stampPosts = new Set<number>();
  for (const chain of runs) {
    const idx: number[] = [chain[0].from];
    for (const link of chain) {
      idx.push(link.to);
    }
    const closedRun = idx.length > 1 && idx[0] === idx[idx.length - 1];
    if (closedRun) {
      idx.pop();
    }
    for (const i of idx) {
      stampPosts.add(i);
    }
    const local = new Map(idx.map((g, l) => [g, l]));
    fences.push({
      closed: closedRun,
      posts: idx.map((g) => ({ ...posts[g] })),
      bays: chain.map(({ bay, from, to }) => ({
        from: local.get(from)!,
        to: local.get(to)!,
        length: bay.length,
        y: bay.y,
        groundMax: bay.groundMax,
      })),
    });
  }

  // Feet last: a foot is measured from a line, and the lines only stopped moving
  // above. A stake follows its ground down, clamped by `maxDrop`.
  for (const fence of fences) {
    for (const post of fence.posts) {
      const ground = groundAt ? groundAt(post.x, post.z) : post.y;
      const stand = Math.max(post.y - maxDrop, Math.min(post.y, ground)) - foot;
      if (stand < post.base) {
        (post as { base: number }).base = stand;
      }
    }
  }

  for (const fence of fences) {
    for (const post of fence.posts) {
      const tpl =
        post.kind === "lantern" ? parts.lantern : post.kind === "tall" ? parts.tall : parts.post;
      // Stretched from its foot to the line's post height, girth fixed at 1. A
      // variant taller than `postH` stamps at 1, keeping its painted shape.
      const ownH =
        post.kind === "lantern" ? parts.lanternH : post.kind === "tall" ? parts.tallH : parts.postH;
      const sy = Math.max(1, (post.y + parts.postH - post.base) / ownH);
      solid.add(tpl, post.x, post.base, post.z, post.yaw, 1, sy);
      if (post.kind === "lantern" && opts.glow) {
        opts.glow.add(parts.lanternGlow, post.x, post.base, post.z, post.yaw, 1, 1, 1, 1);
      }
    }
    stampBays(solid, parts, fence);
  }

  return fences;
}

function stampBays(solid: SolidStamp, parts: FenceParts, fence: Fence): void {
  for (const bay of fence.bays) {
    const a = fence.posts[bay.from];
    const b = fence.posts[bay.to];
    const { length: len, y } = bay;
    if (len < 1e-3) {
      continue;
    }
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.atan2(dx, dz);
    const mx = a.x + dx * 0.5;
    const mz = a.z + dz * 0.5;
    // Rail and post share one authored width: recess the plank inside the post
    // faces so no coplanar pair fights in the depth buffer.
    const sx = parts.railWidth / parts.postWidth;
    const sz = len / parts.railLen;
    for (let k = 0; k < parts.railAt.length; k++) {
      // Only the TOP course is solid; a second box under it blocks nothing.
      const tpl = k === parts.railAt.length - 1 ? parts.rail : parts.railProp;
      solid.add(tpl, mx, y + parts.railAt[k], mz, yaw, sx, 1, sz);
    }
  }
}
