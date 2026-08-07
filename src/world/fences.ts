/**
 * FENCES — one chain of posts, one plank per gap, everywhere in the world.
 *
 * A fence in this world used to be a fixed-length PANEL stamped at whatever
 * interval its caller felt like: 4.2 units along a road, 4.2 along a hamlet's
 * paddock arc, and a whole railing unit at every bridge deck sample whether the
 * next sample was 3 units away or 3.4. That is issue #105, and every symptom in
 * it is the same bug — a panel cannot see its neighbour, so its planks join to
 * one stake and stop in mid-air short of the next.
 *
 * So a fence is not a panel here. It is a PATH, and this file turns a path into:
 *
 *   1. POSTS, one at the start, one at the end, and the rest spread evenly
 *      between them at a gap the caller bounds — never wider than `maxGap`,
 *      never tighter than `minGap` unless the whole run is shorter than one;
 *   2. BAYS, one per adjacent pair, each carrying planks stamped at the bay's
 *      own bearing and stretched (`Accum.add`'s `sz`) to the bay's own length.
 *
 * THE INVARIANT, and the reason the arithmetic below is worth the file: every
 * plank ends INSIDE the two posts it joins, at a height both of them carry.
 * Both halves are by construction rather than by tuning —
 *
 *   - a plank is stamped at the bay's midpoint with `sz = gap / railLen`, so its
 *     ends land exactly on the two post centres whatever the gap is;
 *   - a plank sits at `min(yA, yB) + railAt`, and a post spans its own base up
 *     to `y + postH`, with `railAt < postH`. The LOWER post's top is the binding
 *     one at the top of the fence, and the UPPER post's FOOT is the binding one
 *     at the bottom: on a bank its stake is pulled down until it reaches the
 *     lowest plank it carries, which is what makes a fence on a slope a fence
 *     rather than a row of stakes with boards floating past them.
 *
 * `tools/test-fence.mjs` asserts exactly those two statements over every fence
 * the demo stages build, plus the spacing bound, plus that no post floats over
 * or sinks under the surface it stands on.
 *
 * TURNS come for free: a path is a polyline, posts are laid along its arc
 * length, and a post's yaw is the mean bearing of the bays either side of it, so
 * a corner post's fork faces the corner. A path that closes (`closed: true`) is
 * a ring with no seam.
 *
 * A BAY MAY BE REFUSED. `accept` is asked about each one before it is stamped,
 * and a refusal drops the PLANKS while keeping both posts — so what a road
 * crossing a pasture fence leaves behind is a gap between two standing posts,
 * i.e. a field gate, rather than a plank lying across the carriageway. That was
 * `fencePanel`'s job in towns.ts and it is the same test, asked per bay.
 */
import { Accum, type Template } from './props';
import type { SolidStamp } from './structures';

/**
 * The pieces one fence is built from, and the four numbers that say how they
 * fit together. `TownParts.fence` is the ground world's kit; a second world
 * hands its own (see world/sky-parts.ts).
 *
 * The metrics are the CONTRACT between the kit and this file: the builder that
 * paints a post decides how tall it is, and nothing here restates that number.
 */
export interface FenceParts {
  /** The plain stake, drawn from its base along +y. */
  readonly post: Template;
  /** A taller stake, same origin. */
  readonly tall: Template;
  /** A taller stake with a lantern cage on top. */
  readonly lantern: Template;
  /** The flame in that cage, for the caller's glow accumulator. */
  readonly lanternGlow: Template;
  /** One plank along +z, `railLen` long, carrying the fence's collider. */
  readonly rail: Template;
  /** The same plank with no collider, for every course below the top one. */
  readonly railProp: Template;
  /** How long that plank template is, i.e. what a bay's `sz` divides by. */
  readonly railLen: number;
  /** Plank BOTTOMS above the fence line, lowest first. Last one is the top. */
  readonly railAt: readonly number[];
  /** How far a plain stake stands above the line. Must exceed every `railAt`. */
  readonly postH: number;
  /** Total height of the taller stake, so a stretched one can be measured. */
  readonly tallH: number;
  /** Total height of the lantern stake, cage and all. */
  readonly lanternH: number;
  /** Half-width of a stake, for the caller's clearance tests. */
  readonly postR: number;
}

/** A point on the path a fence follows. `y` is the line the fence is laid on. */
export interface FenceNode {
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

export type FencePostKind = 'post' | 'tall' | 'lantern';

export interface FencePost {
  readonly x: number;
  readonly z: number;
  /** The fence line here — planks hang off this, the stake stands on it. */
  readonly y: number;
  /** Where the stake's foot is, once it has been dropped onto the ground. */
  readonly base: number;
  readonly yaw: number;
  readonly kind: FencePostKind;
}

export interface FenceBay {
  /** Index of the post this bay leaves, and of the one it arrives at. */
  readonly from: number;
  readonly to: number;
  readonly length: number;
  /** Height of the LOWEST plank's bottom. The rest are `railAt` above the line. */
  readonly y: number;
  /** False when `accept` refused it: the two posts stand, the planks do not. */
  readonly planked: boolean;
}

export interface Fence {
  readonly posts: readonly FencePost[];
  readonly bays: readonly FenceBay[];
}

export interface FenceOptions {
  /** Longest a bay may be. Posts are added until every gap is under it. */
  readonly maxGap?: number;
  /** Shortest a bay may be, unless the whole path is shorter than one. */
  readonly minGap?: number;
  /** Close the ring: a final bay from the last post back to the first. */
  readonly closed?: boolean;
  /** Every Nth post is a lantern post. 0 (the default) is none. */
  readonly lanternEvery?: number;
  /** Every Nth post is a tall one. Lanterns win where the two coincide. */
  readonly tallEvery?: number;
  /**
   * The walking surface under a post, when the fence line is not it.
   *
   * A bridge railing's line is the DECK and the ground under it is the river
   * bed; a pasture fence's line is the ground itself. Where the two differ, the
   * stake is sunk to whichever is lower so its foot is never in the air — the
   * "posts clipping through the ground" half of issue #105 is the same
   * arithmetic with the wrong sign. The drop is clamped by `maxDrop`, or a
   * railing at an abutment grows a ten-unit leg down to the river bed.
   */
  readonly groundAt?: (x: number, z: number) => number;
  /** How far a stake may follow the ground down before it stops. */
  readonly maxDrop?: number;
  /** How deep every stake is set into what it stands on. */
  readonly foot?: number;
  /** Vetoes one bay's planks — see the note on gates at the top of this file. */
  readonly accept?: (
    ax: number, az: number, bx: number, bz: number,
  ) => boolean;
  /** Where a lantern's flame goes. Lantern posts are plain without it. */
  readonly glow?: Accum;
}

const DEFAULT_MAX_GAP = 3.2;
const DEFAULT_MIN_GAP = 1.6;
/**
 * How far a stake follows the ground down before it gives up, world units.
 *
 * A bridge railing stands on the deck with open water under it, so `groundAt`
 * answers the river bed — twelve units below in the middle of a span. Without a
 * clamp every stake on the bridge grows a leg down to it. 1.4 is deep enough to
 * cover the abutment, where the bank meets the deck and the ground under the
 * railing drops away over one bay, and short enough that a leg that does hang
 * free is behind the deck's own skirt (`RIBBON_SKIRT`, 1.1).
 */
const DEFAULT_MAX_DROP = 1.4;
/** How deep a stake is set into what it stands on. A quarter of a stake. */
const DEFAULT_FOOT = 0.35;

/**
 * Lay `path` out as posts and stamp the fence.
 *
 * The path is a polyline of ARBITRARY spacing — the caller hands over the shape
 * it means (a road's verge sampled every 3 units, four corners of a paddock,
 * the rim of an island) and this decides where the posts go. That is the whole
 * point of the file: the caller cannot get the spacing wrong because it does not
 * choose it.
 */
export function buildFence(
  solid: SolidStamp,
  parts: FenceParts,
  path: readonly FenceNode[],
  opts: FenceOptions = {},
): Fence {
  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP;
  const minGap = Math.min(opts.minGap ?? DEFAULT_MIN_GAP, maxGap);
  const foot = opts.foot ?? DEFAULT_FOOT;
  const maxDrop = opts.maxDrop ?? DEFAULT_MAX_DROP;

  const nodes = opts.closed && path.length > 2 ? [...path, path[0]] : path;
  if (nodes.length < 2) return { posts: [], bays: [] };

  // -- arc length ------------------------------------------------------------
  const seg: number[] = [0];
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    total += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
    seg.push(total);
  }
  if (total < 1e-3) return { posts: [], bays: [] };

  /**
   * HOW MANY BAYS, and the reason it is a division rather than a walk.
   *
   * Stepping `maxGap` along the path and posting where you land leaves a
   * remainder at the far end — the stub bay that made the old bridge railing
   * look like it had lost a plank. Dividing the run into `ceil(len / maxGap)`
   * EQUAL bays instead means the last bay is the same as the first and the end
   * post lands exactly on the end of the path, which is the requirement.
   *
   * `minGap` then only bites on a short run: three bays of 1.1 on a 3.3-unit
   * arc are stakes almost touching, so the count drops until they are not. A
   * run shorter than one `minGap` is a single bay, because two posts and a
   * plank is the smallest thing that is still a fence.
   */
  let bays = Math.max(1, Math.ceil(total / maxGap));
  while (bays > 1 && total / bays < minGap) bays--;
  const gap = total / bays;

  /** The path point at arc length `s`, interpolating the line height with it. */
  const at = (s: number): FenceNode => {
    let i = 1;
    while (i < seg.length - 1 && seg[i] < s) i++;
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

  // -- posts -----------------------------------------------------------------
  const ring = opts.closed && path.length > 2;
  const count = ring ? bays : bays + 1;
  const pts: FenceNode[] = [];
  for (let i = 0; i < count; i++) pts.push(at(i * gap));

  const posts: Array<{ -readonly [K in keyof FencePost]: FencePost[K] }> = [];
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    // A post faces the mean of the bays either side of it, so a corner post's
    // fork bisects the corner and both planks land in it. The ends of an open
    // run take their single bay's bearing.
    const prev = i > 0 ? pts[i - 1] : ring ? pts[count - 1] : null;
    const next = i < count - 1 ? pts[i + 1] : ring ? pts[0] : null;
    let dx = 0;
    let dz = 0;
    for (const [a, b] of [[prev, p], [p, next]] as const) {
      if (!a || !b) continue;
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      dx += (b.x - a.x) / l;
      dz += (b.z - a.z) / l;
    }
    const yaw = Math.atan2(dx, dz);
    const ground = opts.groundAt ? opts.groundAt(p.x, p.z) : p.y;
    const base = Math.max(p.y - maxDrop, Math.min(p.y, ground)) - foot;
    const every = (n: number | undefined): boolean => !!n && n > 0 && i % n === 0;
    const kind: FencePostKind = every(opts.lanternEvery) && opts.glow
      ? 'lantern'
      : every(opts.tallEvery) ? 'tall' : 'post';
    posts.push({ x: p.x, z: p.z, y: p.y, base, yaw, kind });
  }

  // -- bays, and the second thing a post's length depends on -----------------
  //
  // A bay's planks sit at the LOWER of its two lines, so on a step the UPPER
  // post has to reach further down than its own ground: its foot is otherwise
  // above the bottom plank and that plank ends in mid-air beside it. Measured
  // by `tools/test-fence.mjs` on the world this landed in — 22 bays across the
  // stage and the road network, every one of them on a slope, with the worst
  // pair 1.4 units apart in line height against a 0.42 bottom plank.
  //
  // So the foot is pulled down to whichever is lower: the ground it stands on,
  // or the lowest plank it has to carry. That is what a real fence does on a
  // bank — the uphill stake is the long one — and it is why this runs BEFORE
  // anything is stamped rather than after.
  const out: FenceBay[] = [];
  for (let i = 0; i < bays; i++) {
    const a = posts[i];
    const b = posts[(i + 1) % posts.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    // The LOWER of the two, so both stakes carry material at every plank's
    // height. See the invariant at the top of this file.
    const y = Math.min(a.y, b.y);
    const planked = !opts.accept || opts.accept(a.x, a.z, b.x, b.z);
    out.push({
      from: i, to: (i + 1) % posts.length, length: Math.hypot(dx, dz), y, planked,
    });
    if (!planked) continue;
    const under = y + parts.railAt[0] - foot;
    if (under < a.base) a.base = under;
    if (under < b.base) b.base = under;
  }

  // -- stamping --------------------------------------------------------------
  for (const post of posts) {
    const tpl = post.kind === 'lantern' ? parts.lantern
      : post.kind === 'tall' ? parts.tall : parts.post;
    // The stake is STRETCHED from its foot to the line's own post height, which
    // is how one template covers a stake standing on the deck and the stake
    // beside it reaching a metre down the abutment. Girth stays 1: a post that
    // grew fatter as it grew longer would read as a tree.
    //
    // A VARIANT IS ONLY STRETCHED WHEN IT HAS TO BE. The tall stake and the
    // lantern one are already taller than `postH` — that is what they are for —
    // so on level ground they stamp at 1 and keep the cage the shape it was
    // painted. It is only where a foot has been pulled a long way down a bank
    // that one grows, and then it grows by exactly the amount that puts its top
    // back on the line.
    const ownH = post.kind === 'lantern' ? parts.lanternH
      : post.kind === 'tall' ? parts.tallH : parts.postH;
    const sy = Math.max(1, (post.y + parts.postH - post.base) / ownH);
    solid.add(tpl, post.x, post.base, post.z, post.yaw, 1, sy);
    if (post.kind === 'lantern' && opts.glow) {
      opts.glow.add(parts.lanternGlow, post.x, post.base, post.z, post.yaw, 1, 1, 1, 1);
    }
  }

  for (const bay of out) {
    const a = posts[bay.from];
    const b = posts[bay.to];
    const { length: len, y, planked } = bay;
    if (!planked || len < 1e-3) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.atan2(dx, dz);
    const mx = a.x + dx * 0.5;
    const mz = a.z + dz * 0.5;
    const sz = len / parts.railLen;
    for (let k = 0; k < parts.railAt.length; k++) {
      // Only the TOP course is solid: it spans the bay end to end, so a second
      // box under it blocks nothing a body could pass anyway and costs a query.
      const tpl = k === parts.railAt.length - 1 ? parts.rail : parts.railProp;
      solid.add(tpl, mx, y + parts.railAt[k], mz, yaw, 1, 1, sz);
    }
  }

  return { posts, bays: out };
}
