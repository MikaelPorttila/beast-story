import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';

/**
 * THE TAMING ORB A PLAYER THROWS.
 *
 * Beside combat/arrow.ts and for the same reason that file gives: an orb is not
 * a thing the hero HOLDS, it is a projectile, and everything about its life —
 * the pool slot, the homing, the hit test, the capture — belongs to
 * `CombatSystem`. The four tiers differ in exactly one thing that is visible,
 * their glass colour, so this is ONE builder with a colour argument rather than
 * four drawings; `ItemDef.color` is where those colours are written down, which
 * is also what the inventory glyph is tinted from.
 *
 * BUILT ALONG +Z, like the arrow, because the pool aims a slot with
 * `Object3D.lookAt`. A sphere has no front, so nothing about the SHAPE requires
 * it — but the seam does: an orb spinning about an axis that is not its own
 * travel direction reads as a tumbling pebble, and one whose band stays square
 * to its flight reads as a thing that was thrown deliberately.
 *
 * ONE GEOMETRY PER TIER, BUILT ONCE. Four orbs at four colours is four meshes
 * the pool clones nothing from — each pooled slot holds its own instance because
 * a slot in flight has to be able to be a different tier from the last shot,
 * and four spare meshes of ~200 voxels are cheaper than rebuilding one per
 * throw. See `buildTameOrb` and the cache below it.
 */

// Finer than the hero's 0.1 and coarser than the arrow's 0.055: an orb is a
// small round thing, and at 0.055 the band's three voxel rows would be 1.7 cm
// of a 3 cm ball — visible only as a smudge. 0.07 puts the whole orb at about
// 22 cm across, which is a thing a person throws.
const S = 0.07;

/** The seam, and the light inside it. Constant across tiers — see the header. */
const BAND = 0xf4f7fb;
const CORE = 0xfff3c4;

/**
 * A hollow-looking glass ball with an equatorial seam and a lit core.
 *
 * The shell is TWO ellipsoids and not one: the outer is the tier's colour and
 * the inner, one voxel smaller and darker, is what gives the silhouette a rim
 * when the sun is behind it. Both are solid — `VoxelModel.build` culls every
 * face that has a neighbour, so the interior costs nothing in triangles and the
 * inner shell only shows where the outer one steps.
 *
 * THE CORE IS EMISSIVE AND IN THE SAME MODEL, which is what makes the
 * `GLOW_PART` offset (world/town-parts.ts) unnecessary here: that nudge exists
 * because a glow painted as a SEPARATE `VoxelModel` re-bases on its own bounds
 * and lands on the same face planes as the body. One model, one origin, no
 * coincident faces — and `bun tools/test-zfight.mjs` is what proves it rather
 * than this paragraph.
 */
export function buildTameOrb(color: number): THREE.Mesh {
  const v = new VoxelModel();
  const r = 3;
  // Shell. Radii equal on all three axes — it is a ball, and the +Z build
  // direction is about the SEAM's orientation, not the body's.
  v.ellipsoid(0, 0, 0, r, r, r, color);
  v.ellipsoid(0, 0, 0, r - 1, r - 1, r - 1, shade(color, 0.62));
  // The lit core, two voxels across, buried where the shell's step lets it show
  // through the seam. Emissive so it reads at night and inside the capture
  // flash, which is the one moment the player is looking straight at it.
  for (let x = -1; x <= 0; x++) {
    for (let y = -1; y <= 0; y++) {
      for (let z = -1; z <= 0; z++) v.setEmissive(x, y, z, CORE, 2.2);
    }
  }
  // The seam: a ring in the XY plane, so it faces square to the direction of
  // travel. Painted last, so it overwrites the shell rather than being hidden
  // under it.
  for (let x = -r; x <= r; x++) {
    for (let y = -r; y <= r; y++) {
      const d = Math.hypot(x, y);
      if (d > r - 0.6 && d <= r + 0.4) {
        v.set(x, y, 0, BAND);
        // The catch on the band: one voxel proud at the top, which is what
        // makes a spinning orb read as spinning rather than as a still ball.
        if (y === r) v.set(x, y, 1, shade(BAND, 0.8));
      }
    }
  }
  // `center: true` — the pool positions and rotates about the orb's middle,
  // which for a ball is also its centre of mass and the point it wobbles about
  // once it is on the ground.
  return v.build(S, true);
}

/**
 * One mesh per colour, built on demand and kept.
 *
 * A MAP AND NOT AN ARRAY BY TIER, because what the model actually varies on is
 * the colour: two tiers that shared one would share a mesh, and a fifth orb is
 * a catalogue entry rather than a code change. Keyed on the number so an
 * `ItemDef.color` reaches it with no translation.
 */
const cache = new Map<number, THREE.Mesh>();

/**
 * The orb mesh for this colour, built once.
 *
 * THE CALLER CLONES IT AND KEEPS THE CLONE. A pooled projectile slot cannot hold
 * this object itself — two orbs of the same tier can be in flight at once, and
 * an `Object3D` is in one place at a time — so `projSlot` in combat/index.ts
 * keeps a per-slot clone per colour and reuses it on every later throw of that
 * tier. That is what keeps a throw allocation-free after the first of its kind.
 *
 * Sharing the GEOMETRY and the MATERIAL across those clones is the point of the
 * cache: `THREE.Mesh.clone()` reuses both, so every live orb of a tier is one
 * more draw call and no new buffers.
 */
export function tameOrbMesh(color: number): THREE.Mesh {
  let m = cache.get(color);
  if (!m) {
    m = buildTameOrb(color);
    cache.set(color, m);
  }
  return m;
}

/**
 * Give the cached meshes back. Called from `CombatSystem.dispose`.
 *
 * The cache outlives any one pool slot — it is module state, like the arrow's
 * shared geometry — so this is the only place that can free it, and it has to
 * exist for the rule in AGENTS.md that everything added to the scene has a
 * matching dispose path. Nothing here was ever added to a scene; the CLONES
 * were, and they are the pool's to REMOVE. They must not also be disposed:
 * a clone shares this geometry and material, so freeing them is this function's
 * job and doing it twice is what the pool must not do.
 */
export function disposeTameOrbs(): void {
  for (const mesh of cache.values()) {
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    // The emissive core rides as a child mesh with its own material — see
    // `VoxelModel.build`, which batches emissive cells into their own meshes.
    mesh.traverse((o) => {
      const child = o as THREE.Mesh;
      if (child !== mesh && child.isMesh) {
        child.geometry.dispose();
        const cm = child.material;
        if (Array.isArray(cm)) cm.forEach((m) => m.dispose());
        else cm.dispose();
      }
    });
  }
  cache.clear();
}
