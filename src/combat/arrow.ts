import * as THREE from "three";
import { VoxelModel } from "../core/voxel";

// Built along +Z (not +Y like every other model): `lookAt` aims the pool's
// group down +Z, so travel direction must be the model's long axis.

const S = 0.055; // finer voxel than the hero's 0.1: an arrow is a thin thing

const SHAFT = 0xb08a52;
const SHAFT_D = 0x8a6a3c;
const HEAD = 0xcdd8e2;
const HEAD_D = 0x8e9aa5;
const FLETCH = 0xe4e9ef;

export function buildArrow(): THREE.Mesh {
  const v = new VoxelModel();
  // Two voxels of cross-section: a 1-voxel plane vanishes seen edge-on.
  for (let z = -6; z <= 4; z++) {
    v.set(0, 0, z, SHAFT);
    v.set(0, -1, z, SHAFT_D);
  }
  v.set(0, 0, 5, HEAD);
  v.set(0, -1, 5, HEAD_D);
  v.set(1, 0, 5, HEAD_D);
  v.set(-1, 0, 5, HEAD_D);
  v.set(0, 0, 6, HEAD);
  v.set(0, 0, 7, HEAD);
  // Fletching: vertical + horizontal vane, so it reads at any roll angle.
  for (let z = -6; z <= -4; z++) {
    v.set(0, 1, z, FLETCH);
    v.set(1, 0, z, FLETCH);
    v.set(-1, 0, z, FLETCH);
  }
  // Uncentered: origin must stay mid-shaft, the point the pool rotates about.
  return v.build(S, true);
}
