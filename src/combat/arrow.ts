import * as THREE from 'three';
import { VoxelModel } from '../core/voxel';

/**
 * THE ARROW A BOW FIRES.
 *
 * It lives beside the projectile pool rather than in player/weapons.ts with the
 * bow, because an arrow is not a thing the hero HOLDS — it is a projectile, and
 * everything about its life (the pool slot, the homing, the hit test, the
 * expiry) is `CombatSystem`'s. The bow that fires it is the hero's; the arrow in
 * flight is combat's, exactly as a beast's flame dart is.
 *
 * BUILT ALONG +Z, because that is what `Object3D.lookAt` points down: the pool
 * aims the whole group at where it is going, so the model has to be lying in the
 * direction of travel with the head furthest forward. Everything else in this
 * codebase builds up +Y; this is the one that does not, and it is the reason
 * why.
 *
 * ONE GEOMETRY AND ONE MATERIAL, built once and shared by every slot in the
 * pool — an arrow is the same arrow every time, and the pool is capped, so this
 * costs one draw call per live shot and no allocation per shot.
 */

const S = 0.055;   // finer voxel than the hero's 0.1: an arrow is a thin thing

const SHAFT = 0xb08a52;
const SHAFT_D = 0x8a6a3c;
const HEAD = 0xcdd8e2;
const HEAD_D = 0x8e9aa5;
const FLETCH = 0xe4e9ef;

export function buildArrow(): THREE.Mesh {
  const v = new VoxelModel();
  // Shaft, running forward in +z. Two voxels of cross-section rather than one,
  // for the reason every blade in player/weapons.ts is stepped: a 1-voxel plane
  // seen edge-on is nothing at all, and an arrow is seen from the side by the
  // player who fired it and end-on by everyone else.
  for (let z = -6; z <= 4; z++) {
    v.set(0, 0, z, SHAFT);
    v.set(0, -1, z, SHAFT_D);
  }
  // Head: a short taper, brighter than the shaft so the point reads first.
  v.set(0, 0, 5, HEAD);
  v.set(0, -1, 5, HEAD_D);
  v.set(1, 0, 5, HEAD_D);
  v.set(-1, 0, 5, HEAD_D);
  v.set(0, 0, 6, HEAD);
  v.set(0, 0, 7, HEAD);
  // Fletching: two vanes at the tail, one vertical and one horizontal, so the
  // arrow reads as fletched from any roll angle.
  for (let z = -6; z <= -4; z++) {
    v.set(0, 1, z, FLETCH);
    v.set(1, 0, z, FLETCH);
    v.set(-1, 0, z, FLETCH);
  }
  // `center: false` — the origin has to stay the point the pool positions and
  // rotates about, which is the middle of the shaft rather than the middle of
  // the model's bounds.
  return v.build(S, true);
}
