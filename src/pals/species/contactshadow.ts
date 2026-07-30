import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Ground contact blob for the flyers.
//
// The flying rigs ARE in the shadow-caster set (PalActor turns castShadow on for
// every mesh it finds), but a flyer hovers ~1.55 units up and this world's sun is
// low, so its real shadow lands a metre and a half behind it — often on a
// different terrace, often out of frame. The result in portraits and in gameplay
// alike is a creature pasted in front of the scenery instead of standing in it.
//
// Cube World solves this the cheap way and so do we: a soft dark ellipse on the
// ground directly beneath the rig. One extra draw call per flyer, no shadow-map
// work, and it gives the eye the vertical cue the real shadow cannot.
// ---------------------------------------------------------------------------

let blobTexture: THREE.CanvasTexture | null = null;

/** One shared 64px radial alpha ramp (opaque centre -> clear rim). */
function getBlobTexture(): THREE.CanvasTexture {
  if (blobTexture) return blobTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Flat-ish core then a fast falloff: a linear ramp reads as a blurry smudge,
    // this reads as a shadow with a soft edge.
    g.addColorStop(0.0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.32)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  blobTexture = new THREE.CanvasTexture(canvas);
  return blobTexture;
}

/**
 * A flat ground blob to parent to a flyer's rig ROOT (not its body — it must not
 * inherit the wingbeat bob). `radius` is in world units; `drop` is how far below
 * the root the ground sits, i.e. the species' hover height.
 */
export function makeContactBlob(radius: number, drop: number, opacity = 0.34): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2);
  geo.rotateX(-Math.PI / 2); // bake the lie-flat rotation in, so quaternion work below is pure cancel
  const mat = new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: 0x1a1d16,     // the terrain's own shadow tint, not pure black
    transparent: true,
    opacity,
    depthWrite: false,   // never occlude the grass blades it lies on
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -drop;
  mesh.renderOrder = -1; // draw before the creature; it is scenery, not decal-on-top
  return mesh;
}

const _q = new THREE.Quaternion();

/**
 * Keep the blob flat on the ground and sized for the pose. Call once per frame
 * from the species' animate().
 *
 * - The rig root carries pitch/yaw/bank, so the blob has to cancel the root's
 *   rotation or it banks with the creature and slices into the terrain.
 * - PalActor's constructor traverses the rig and sets castShadow on every mesh,
 *   which would make this blob cast a hard-edged shadow of its own quad. Clearing
 *   the flag here (a plain boolean store, effectively free) is the only hook a
 *   species file has after that traverse has run.
 */
export function updateContactBlob(
  blob: THREE.Object3D, root: THREE.Object3D, spread: number,
): void {
  blob.quaternion.copy(_q.copy(root.quaternion).invert());
  blob.scale.set(spread, 1, spread);
  const m = blob as THREE.Mesh;
  m.castShadow = false;
  m.receiveShadow = false;
}
