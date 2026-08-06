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

/**
 * Voxel size, and the radius in voxels. The pair is one decision.
 *
 * FINE AND MANY rather than coarse and few, which the first version got the
 * wrong way round: at radius 3 the "ellipsoid" is eleven voxels across at its
 * equator and four at its poles, and `shots/lab-orbs.png` showed it reading as a
 * chunky wheel rather than as a ball. Radius 5 rounds the silhouette — the
 * corner step drops from a quarter of the radius to under a seventh — and 0.042
 * keeps the finished size where it was: 10 x 0.042 is 42 cm across at the scale
 * a landed orb wears, which is a thing a person throws.
 *
 * Still coarser than the arrow's 0.055 relative to its own body, because an
 * arrow is a thin thing seen against the sky and an orb is a solid seen against
 * grass.
 */
const S = 0.042;
const R = 5;

/**
 * The orb's radius in WORLD units, at the size it is built.
 *
 * Exported because combat/taming.ts has to sit a landed one exactly on the turf,
 * and the first version of that arithmetic wrote `3 * 0.07` out by hand — which
 * is two of this file's constants copied into another file, and which was
 * silently wrong the moment either moved. Derived, it cannot be.
 */
export const ORB_RADIUS = R * S;

/**
 * How much bigger a LANDED orb is drawn than a thrown one.
 *
 * In flight it is sixteen units a second of moving speck and its size does not
 * matter; on the ground it is the only thing on screen and the player is reading
 * a wobble off it from behind the hero's shoulder.
 */
export const LANDED_SCALE = 1.5;

/** The seam, and the light inside it. Constant across tiers — see the header. */
const BAND = 0xf4f7fb;
const CORE = 0xfff3c4;

/**
 * A glass ball with a lit equatorial seam.
 *
 * THE GLOW IS ON THE SURFACE, and it took `bun tools/test-zfight.mjs` to say so:
 * the first version buried an emissive core two voxels wide at the centre of a
 * SOLID shell, and the report came back with one part and 192 faces — every
 * cell of that core has six neighbours, so `VoxelModel.build` culled all of it
 * and the "lit core" was geometry that never existed. A glow inside an opaque
 * ball is not dim, it is absent.
 *
 * So the seam itself is what glows. That is also the better reading of the item:
 * an orb is described as warm at the seam (src/i18n/en.ts), and a bright ring
 * around a dark ball is a silhouette at any distance where a bright point is one
 * pixel.
 *
 * IT IS ALL ONE `VoxelModel`, which is what makes the `GLOW_PART` offset
 * (world/town-parts.ts) unnecessary here: that nudge exists because a glow
 * painted as a SEPARATE model re-bases on its own bounds and lands on the same
 * face planes as the body. One model, one origin, no coincident faces — and the
 * z-fight guard is what proves it rather than this paragraph.
 */
export function buildTameOrb(color: number): THREE.Mesh {
  const v = new VoxelModel();
  const r = R;
  // Shell, ONE COLOUR. Radii equal on all three axes — it is a ball, and the +Z
  // build direction is about the SEAM's orientation, not the body's.
  //
  // There was a second, darker ellipsoid one voxel inside this, meant to give
  // the silhouette a rim. It was DEAD PAINT: at radius 5 every cell of it has
  // six neighbours in the outer shell, so `VoxelModel.build` culled all of it
  // and removing it changed the capture by not one pixel. The stepping you can
  // see on the curve is the sphere's own rasterisation, and the voxel normals
  // are what shade it — this is the same look every other body in the game has.
  v.ellipsoid(0, 0, 0, r, r, r, color);
  // The seam: a ring in the XY plane, so it faces square to the direction of
  // travel. Painted last, so it overwrites the shell rather than being hidden
  // under it, and EMISSIVE so the orb reads at night and inside the capture
  // flash — the one moment the player is looking straight at it.
  //
  // ONE VOXEL WIDE and dim. It was three wide and at 1.6 intensity, which with
  // bloom on top made a white band as thick as the ball was deep — the capture
  // in shots/lab-orbs.png is what said so. A seam is a line, and the thing it
  // has to be readable AGAINST is the tier's own colour.
  for (let x = -r; x <= r; x++) {
    for (let y = -r; y <= r; y++) {
      const d = Math.hypot(x, y);
      if (d > r - 1.05 && d <= r + 0.3) {
        v.setEmissive(x, y, 0, BAND, 0.85);
        // The catch on the band: one voxel proud at the top, which is what
        // makes a spinning orb read as spinning rather than as a still ball.
        // Not emissive — it is a hinge, not a light, and it is what stops the
        // ring reading as a perfectly symmetrical halo.
        if (y === r - 1) v.set(x, y, 1, shade(BAND, 0.72));
      }
    }
  }
  // The eye: a lit dot at the front of the seam, where the +Z build direction
  // points. It is the one asymmetry that says which way the orb is travelling.
  v.setEmissive(0, 0, r - 1, CORE, 1.6);
  v.setEmissive(1, 0, r - 1, CORE, 1.6);
  v.setEmissive(0, 1, r - 1, CORE, 1.6);
  v.setEmissive(1, 1, r - 1, CORE, 1.6);
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
