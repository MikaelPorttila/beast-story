import * as THREE from 'three';
import { VoxelModel, shade } from '../core/voxel';

// Built along +Z like the arrow: the pool aims a slot with `lookAt`, and the
// seam has to stay square to the direction of travel.

// R=5 rounds the silhouette; S=0.042 keeps the ball ~42 cm across.
const S = 0.042;
const R = 5;

/** World-units radius; combat/taming.ts sits a landed orb on the turf with it. */
export const ORB_RADIUS = R * S;

/** A landed orb is drawn bigger — on the ground it is what the player reads. */
export const LANDED_SCALE = 1.5;

// Constant across tiers; only the glass colour varies.
const BAND = 0xf4f7fb;
const CORE = 0xfff3c4;

/**
 * A glass ball with a lit equatorial seam.
 *
 * The glow must be ON THE SURFACE: a core inside a solid shell has six
 * neighbours per cell, so `VoxelModel.build` culls all of it. One model, one
 * origin, so no `GLOW_PART` offset is needed.
 */
export function buildTameOrb(color: number): THREE.Mesh {
  const v = new VoxelModel();
  const r = R;
  v.ellipsoid(0, 0, 0, r, r, r, color);
  // Seam: a ring in the XY plane, painted last so it overwrites the shell.
  // One voxel wide and dim — wider reads as a white band under bloom.
  for (let x = -r; x <= r; x++) {
    for (let y = -r; y <= r; y++) {
      const d = Math.hypot(x, y);
      if (d > r - 1.05 && d <= r + 0.3) {
        v.setEmissive(x, y, 0, BAND, 0.85);
        // Catch one voxel proud at the top: breaks the halo's symmetry so a
        // spinning orb reads as spinning.
        if (y === r - 1) v.set(x, y, 1, shade(BAND, 0.72));
      }
    }
  }
  // Eye at the +Z pole. Must be at `r`, not `r - 1`: an inner cell is culled.
  v.setEmissive(0, 0, r, CORE, 1.6);
  return v.build(S, true);
}

// Keyed on colour, not tier: a new orb is a catalogue entry, not a code change.
const cache = new Map<number, THREE.Mesh>();

/**
 * The orb mesh for this colour, built once. Callers CLONE it and keep the clone
 * (`projSlot` in combat/index.ts) — a clone shares geometry and material.
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
 * Free the cache; called from `CombatSystem.dispose`. The pool only REMOVES its
 * clones — disposing them too would double-free this shared geometry/material.
 */
export function disposeTameOrbs(): void {
  for (const mesh of cache.values()) {
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    // Emissive cells ride as child meshes with their own material.
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
