/**
 * WHERE A BUILT THING MAY STAND, and what the ground under it does.
 *
 * Three rules, written once because three placement passes were each getting
 * one of them wrong in its own way (issue #212's review):
 *
 *   1. NOTHING FLOATS AND NOTHING SINKS. A thing placed on rolling ground is
 *      drawn at one height while the ground under its far side is at another —
 *      half of it in the air, or half of it buried. `levelPad` flattens the
 *      column it stands on and hands back the height it must be placed at, and
 *      the two are the same number by construction rather than by agreement.
 *   2. NOTHING STANDS IN A ROAD. `roadIntrusion` answers how far inside the
 *      nearest carriageway a point is, measured from the RIM — the same
 *      question `RoadClearance` answers for what is GROWN, asked here for what
 *      is BUILT. A skill den was being sited before any of it and the cart road
 *      ran straight through one.
 *   3. NOTHING STANDS ON WHAT A ROAD ALREADY PUT THERE. A road stands
 *      fingerposts and lamps along itself, and they are as much in the way as a
 *      hut: a waystone's trail was leaving the road at a signpost.
 *
 * It is the placement half of the pair `SiteClearance` (world/structures.ts)
 * makes for vegetation: that one refuses what GROWS inside what is built, this
 * one refuses where a thing may be BUILT at all.
 */
import type { Terrain } from "./terrain";
import type { Road } from "./roads";

/**
 * Level the ground for one placed thing and return the height it sits at.
 *
 * THE 0.55 IS THE CONVENTION, not a nudge: `getHeight` floors a column, so a
 * flatten asked for `h + 0.55` reports exactly `h` to everything that walks on
 * it — the placed thing and the ground agree on one integer. The skill dens
 * have always done this; every other pass now does it the same way instead of
 * inventing its own offset.
 *
 * `core` is levelled flat and `blend` ramps out to the natural ground, so a pad
 * meets the world with a slope rather than a lip. A path crossing the blend
 * follows that slope — which is why the ramp exists and why it must be wide.
 */
export function levelPad(
  terrain: Terrain,
  x: number,
  z: number,
  core: number,
  blend: number,
  waterLevel: number,
): number {
  const h = Math.max(Math.floor(terrain.heightCont(x, z)), waterLevel + 1);
  terrain.flattens.push({ x, z, h: h + 0.55, core, blend });
  return h;
}

/**
 * How far INSIDE the nearest carriageway a point is; negative is clear of it,
 * and the magnitude is the clearance from the rim.
 *
 * EVERY road, never the one a caller happens to be walking: two arms run within
 * a few units of each other at a fork, and an offset that clears the arm a
 * thing was sited from can land in the middle of the other one.
 */
export function roadIntrusion(roads: readonly Road[], x: number, z: number): number {
  let worst = -Infinity;
  for (const road of roads) {
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
      const inside = road.profile.deckEdge - d;
      if (inside > worst) {
        worst = inside;
      }
    }
  }
  return worst;
}

/** True where a road already stood something up — a fingerpost, a lamp, a post. */
export function nearRoadFurniture(
  furniture: readonly { x: number; z: number }[],
  x: number,
  z: number,
  margin: number,
): boolean {
  const m2 = margin * margin;
  for (const f of furniture) {
    if ((f.x - x) ** 2 + (f.z - z) ** 2 < m2) {
      return true;
    }
  }
  return false;
}
