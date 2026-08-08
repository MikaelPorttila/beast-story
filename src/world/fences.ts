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
 * So a fence is not a panel here. It is a PATH, and this file turns a path into
 * one or more CONTINUOUS CHAINS of:
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
 * AND NO PLANK IS IN THE GROUND. A plank is a chord and the ground under it is a
 * staircase of whole-unit columns, so "both posts are above the surface" says
 * nothing about the middle — which is where a bay disappears into a bank. Every
 * bay measures the highest surface along its own length and the line is LIFTED
 * to clear it, up to `maxRise`; past that the bay is refused. See the note on
 * lifting in `buildFence`.
 *
 * `tools/test-fence.mjs` asserts all of that over every fence the demo stage
 * builds AND over the fences the real world builds, plus the spacing bound, plus
 * that no post floats over or sinks under the surface it stands on.
 *
 * TURNS come for free: a path is a polyline, posts are laid along its arc
 * length, and a post's yaw is the mean bearing of the bays either side of it, so
 * a corner post's fork faces the corner. A path that closes (`closed: true`) is
 * a ring with no seam.
 *
 * A BAY MAY BE REFUSED — by `accept` (a carriageway, a hut: see `clearRun` in
 * towns.ts) or by ground no allowed lift clears. A refusal ENDS THE CHAIN and
 * starts a new one on the far side, which is why this returns a list: what a
 * road crossing a pasture fence leaves behind is a gap with a stake either side
 * of it, i.e. a field gate, and each side is still continuous end to end. A
 * stake nothing joins to is dropped with it, so a run whose every bay was
 * refused builds nothing rather than a row of lone posts in a field.
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
  /** Final plank width across the run after stamping. Must be under `postWidth`. */
  readonly railWidth: number;
  /** Finished plank height, used to keep its top below a plain post's top. */
  readonly railHeight: number;
  /** Width of both the authored plank template and the stake it meets. */
  readonly postWidth: number;
  /** Plank BOTTOMS above the fence line, lowest first. Last one is the top. */
  readonly railAt: readonly number[];
  /** How far a plain stake stands above the line. Must exceed each complete rail. */
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
  /** The line this bay's planks hang off: `railAt` above it, lowest first. */
  readonly y: number;
  /**
   * The HIGHEST walking surface anywhere under this bay, sampled along it.
   *
   * Not the endpoints' ground: a bay is a straight chord over ground that is a
   * staircase of whole-unit columns, so the bank that a plank disappears into
   * is usually in the MIDDLE of one. Equal to `y` where the caller gave no
   * `groundAt`, i.e. where the line IS the ground.
   */
  readonly groundMax: number;
}

/**
 * ONE CONTINUOUS CHAIN: a post, a plank, a post, all the way to the end.
 *
 * `buildFence` hands back a LIST of these rather than one fence with holes in
 * it, because a hole is exactly what this file exists to make impossible. Where
 * a bay is refused — a road across a pasture, a hut in the way, a terrace no
 * allowed lift clears — the run ENDS on a post and a new one begins on the far
 * side, which is what a field gate is. `posts.length === bays.length + 1`
 * always, or `=== bays.length` on a ring that lost nothing.
 */
export interface Fence {
  readonly posts: readonly FencePost[];
  readonly bays: readonly FenceBay[];
  /** True when the last bay joins the last post back to the first. */
  readonly closed: boolean;
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
  /**
   * How far the lowest plank must clear the ground under its own bay.
   *
   * A plank is drawn on a chord and the ground under it is a staircase, so
   * "both ends are above the surface" says nothing about the middle — which is
   * the fence-inside-the-bank in issue #105's follow-up. See `RISE_STEP`.
   */
  readonly clearance?: number;
  /**
   * How far the system may LIFT a line above the one the caller gave, to get
   * the planks over a rise. Past it the bay is refused rather than flown.
   */
  readonly maxRise?: number;
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
 * How far the lowest plank clears the ground under its bay, world units.
 *
 * Small on purpose: this is a fence, not a bridge, and a hand's breadth of
 * daylight under the bottom rail is what a real one has. It only has to be big
 * enough that a surface and a plank at the same height do not z-fight, which is
 * the same argument `RIBBON_LIFT` (0.025, town-parts.ts) makes at a quarter the
 * size — and this one is also absorbing the sampling error below.
 */
const DEFAULT_CLEARANCE = 0.08;
/**
 * How far a line may be lifted to clear a rise, world units.
 *
 * The terrain here is FLOORED to whole units (`Terrain.getHeight`), so the step
 * a bay has to get over is normally one unit and occasionally two where a
 * terrace doubles. 1.25 covers the single step with the clearance on top and
 * refuses the double — which is the right answer, because a fence that flies
 * over a two-unit terrace on stilts is worse than one that stops at it. A
 * refused bay leaves its posts, so what you walk up to is a gap at the bank.
 */
const DEFAULT_MAX_RISE = 1.25;
/**
 * How finely the ground under a bay is sampled, world units.
 *
 * A terrain column is 1 unit across and a bay is at most `maxGap` (3.2) long,
 * so 0.4 puts at least two samples in every column a bay crosses. Half a dozen
 * height lookups per bay, a few hundred per world, once at world creation.
 */
const RISE_STEP = 0.4;

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
): Fence[] {
  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP;
  const minGap = Math.min(opts.minGap ?? DEFAULT_MIN_GAP, maxGap);
  const foot = opts.foot ?? DEFAULT_FOOT;
  const maxDrop = opts.maxDrop ?? DEFAULT_MAX_DROP;
  const clearance = opts.clearance ?? DEFAULT_CLEARANCE;
  const maxRise = opts.maxRise ?? DEFAULT_MAX_RISE;
  const groundAt = opts.groundAt;

  const nodes = opts.closed && path.length > 2 ? [...path, path[0]] : path;
  if (nodes.length < 2) return [];

  // -- arc length ------------------------------------------------------------
  const seg: number[] = [0];
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    total += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
    seg.push(total);
  }
  if (total < 1e-3) return [];

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
    const every = (n: number | undefined): boolean => !!n && n > 0 && i % n === 0;
    const kind: FencePostKind = every(opts.lanternEvery) && opts.glow
      ? 'lantern'
      : every(opts.tallEvery) ? 'tall' : 'post';
    // `base` is filled in at the end, once the line has stopped moving.
    posts.push({ x: p.x, z: p.z, y: p.y, base: p.y, yaw, kind });
  }

  // -- getting the fence OUT OF THE GROUND -----------------------------------
  //
  // The caller's line is where it WANTS the fence; it is not necessarily a line
  // a fence fits on. Two things put planks inside a bank, and both are the same
  // mistake — reasoning about a point when a fence is a run:
  //
  //   1. A POST'S OWN COLUMN. A verge is levelled to `round(deck)` and the
  //      terrain is floored to whole units, so a line seated on the minimum over
  //      a footprint (which is what `seatOn` hands over, and rightly, for a
  //      thing that must not stand on a high corner) is up to a unit UNDER the
  //      column the post actually stands in.
  //   2. THE MIDDLE OF A BAY. A plank is a straight chord and the ground under
  //      it is a staircase. Both ends can be clear while the step between them
  //      is not — which is exactly the fence in the bank in the issue's
  //      follow-up screenshot, on a road verge where the shoulder terraces.
  //
  // So the line is LIFTED, per post, by whatever its own column and its own
  // bays need, and never by more than `maxRise` — and a bay that would still be
  // buried after the lift is refused. A fence that stops at a terrace with a
  // post either side of the gap reads as a fence; one that flies over it on
  // stilts, or runs through it, does not.
  //
  // Lifting can only RAISE, so no bay that was clear becomes buried, and one
  // pass is enough — the check afterwards is over the final lines.
  const line0 = posts.map((p) => p.y);
  /** The highest walking surface on the segment a->b, endpoints included. */
  const ridgeUnder = (
    ax: number, az: number, bx: number, bz: number,
  ): number => {
    if (!groundAt) return -Infinity;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / RISE_STEP));
    let hi = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = groundAt(ax + (bx - ax) * t, az + (bz - az) * t);
      if (g > hi) hi = g;
    }
    return hi;
  };
  /** Raise post `i` toward `want`, as far as its own lift allowance goes. */
  const lift = (i: number, want: number): void => {
    if (want <= posts[i].y) return;
    posts[i].y = Math.min(want, line0[i] + maxRise);
  };
  if (groundAt) {
    for (let i = 0; i < posts.length; i++) lift(i, groundAt(posts[i].x, posts[i].z));
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
  /** A bay plus the two things only the settling pass needs. */
  type Settling = FenceBay & { planked: boolean };
  const out: Settling[] = [];
  for (let i = 0; i < bays; i++) {
    const j = (i + 1) % posts.length;
    const a = posts[i];
    const b = posts[j];
    const groundMax = ridgeUnder(a.x, a.z, b.x, b.z);
    // The lift a plank needs to clear the ground under its OWN bay, asked of
    // both posts because a plank hangs off the lower of the two lines.
    if (groundMax > -Infinity) {
      const want = groundMax + clearance - parts.railAt[0];
      lift(i, want);
      lift(j, want);
    }
    out.push({
      from: i, to: j, length: Math.hypot(b.x - a.x, b.z - a.z),
      y: 0, groundMax: groundMax > -Infinity ? groundMax : 0, planked: false,
    });
  }

  // The lines have stopped moving, so now the bays can be settled against them.
  for (let i = 0; i < out.length; i++) {
    const bay = out[i];
    const a = posts[bay.from];
    const b = posts[bay.to];
    // The LOWER of the two, so both stakes carry material at every plank's
    // height. See the invariant at the top of this file.
    const y = Math.min(a.y, b.y);
    // TWO WAYS TO LOSE A BAY, and they are the same answer: no planks, and the
    // run ends here. `accept` is the caller's — a carriageway, a building — and
    // the second is this file's own: after every lift it was allowed, the
    // bottom plank would still be inside the bank.
    const planked = (!opts.accept || opts.accept(a.x, a.z, b.x, b.z))
      && !(groundAt && y + parts.railAt[0] < bay.groundMax + clearance - 1e-6);
    out[i] = { ...bay, y, groundMax: groundAt ? bay.groundMax : y, planked };
    if (!planked) continue;
    const under = y + parts.railAt[0] - foot;
    if (under < a.base) a.base = under;
    if (under < b.base) b.base = under;
  }

  // -- A REFUSED BAY SPLITS THE RUN ------------------------------------------
  //
  // The invariant this file exists for is that a fence is CONTINUOUS from a
  // start post to an end post. A run with a gate in the middle is therefore not
  // one fence with a hole in it — it is two fences, and saying so is what keeps
  // "posts = bays + 1" true of everything this returns, in the report and in
  // `tools/test-fence.mjs` alike.
  //
  // It also disposes of the lone stake. A post survives only if a planked bay
  // reaches it, so the run whose every bay was refused (measured on the road
  // network: a five-post chain beside a hut, all four bays refused) stamps
  // nothing at all instead of a row of stakes in a field.
  const runs: Array<Array<{ bay: Settling; from: number; to: number }>> = [];
  let run: Array<{ bay: Settling; from: number; to: number }> = [];
  // A ring is unrolled from AFTER a gap where it has one, so a chain is never
  // reported cut at the arbitrary place the path happened to start.
  const first = ring ? Math.max(0, out.findIndex((b) => !b.planked) + 1) : 0;
  for (let k = 0; k < out.length; k++) {
    const bay = out[(first + k) % out.length];
    if (!bay.planked) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ bay, from: bay.from, to: bay.to });
  }
  if (run.length > 0) runs.push(run);
  if (runs.length === 0) return [];

  const fences: Fence[] = [];
  const stampPosts = new Set<number>();
  for (const chain of runs) {
    const idx: number[] = [chain[0].from];
    for (const link of chain) idx.push(link.to);
    // A ring that lost no bay comes back round to its own first post.
    const closedRun = idx.length > 1 && idx[0] === idx[idx.length - 1];
    if (closedRun) idx.pop();
    for (const i of idx) stampPosts.add(i);
    const local = new Map(idx.map((g, l) => [g, l]));
    fences.push({
      closed: closedRun,
      posts: idx.map((g) => ({ ...posts[g] })),
      bays: chain.map(({ bay, from, to }) => ({
        from: local.get(from)!, to: local.get(to)!,
        length: bay.length, y: bay.y, groundMax: bay.groundMax,
      })),
    });
  }

  // -- and now the feet ------------------------------------------------------
  // Last, because a foot is measured from a line, and the line only stopped
  // moving above. A stake follows its own ground down (clamped by `maxDrop`, or
  // a railing at an abutment grows a leg to the river bed) and is then pulled
  // further by any plank it has to carry — see the bay loop.
  for (const fence of fences) {
    for (const post of fence.posts) {
      const ground = groundAt ? groundAt(post.x, post.z) : post.y;
      const stand = Math.max(post.y - maxDrop, Math.min(post.y, ground)) - foot;
      if (stand < post.base) (post as { base: number }).base = stand;
    }
  }

  // -- stamping --------------------------------------------------------------
  for (const fence of fences) {
    for (const post of fence.posts) {
      const tpl = post.kind === 'lantern' ? parts.lantern
        : post.kind === 'tall' ? parts.tall : parts.post;
      // The stake is STRETCHED from its foot to the line's own post height,
      // which is how one template covers a stake standing on the deck and the
      // stake beside it reaching a metre down the abutment. Girth stays 1: a
      // post that grew fatter as it grew longer would read as a tree.
      //
      // A VARIANT IS ONLY STRETCHED WHEN IT HAS TO BE. The tall stake and the
      // lantern one are already taller than `postH` — that is what they are
      // for — so on level ground they stamp at 1 and keep the cage the shape it
      // was painted. It is only where a foot has been pulled a long way down a
      // bank that one grows, and then it grows by exactly the amount that puts
      // its top back on the line.
      const ownH = post.kind === 'lantern' ? parts.lanternH
        : post.kind === 'tall' ? parts.tallH : parts.postH;
      const sy = Math.max(1, (post.y + parts.postH - post.base) / ownH);
      solid.add(tpl, post.x, post.base, post.z, post.yaw, 1, sy);
      if (post.kind === 'lantern' && opts.glow) {
        opts.glow.add(parts.lanternGlow, post.x, post.base, post.z, post.yaw, 1, 1, 1, 1);
      }
    }
    stampBays(solid, parts, fence);
  }

  return fences;
}

/** The planks of one continuous chain, each stretched to its own bay. */
function stampBays(solid: SolidStamp, parts: FenceParts, fence: Fence): void {
  for (const bay of fence.bays) {
    const a = fence.posts[bay.from];
    const b = fence.posts[bay.to];
    const { length: len, y } = bay;
    if (len < 1e-3) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const yaw = Math.atan2(dx, dz);
    const mx = a.x + dx * 0.5;
    const mz = a.z + dz * 0.5;
    // The authored rail and post share one voxel width. Recess the finished
    // plank inside the post faces so it grows visibly from the middle of each
    // side instead of leaving coplanar faces to fight in the depth buffer.
    const sx = parts.railWidth / parts.postWidth;
    const sz = len / parts.railLen;
    for (let k = 0; k < parts.railAt.length; k++) {
      // Only the TOP course is solid: it spans the bay end to end, so a second
      // box under it blocks nothing a body could pass anyway and costs a query.
      const tpl = k === parts.railAt.length - 1 ? parts.rail : parts.railProp;
      solid.add(tpl, mx, y + parts.railAt[k], mz, yaw, sx, 1, sz);
    }
  }
}
