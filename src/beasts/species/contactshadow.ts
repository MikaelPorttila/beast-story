import * as THREE from 'three';

// Ground contact blob for the flyers: the low sun throws a hovering rig's real
// shadow out of frame, so a soft ellipse directly beneath gives the vertical cue.

let blobTexture: THREE.CanvasTexture | null = null;

function getBlobTexture(): THREE.CanvasTexture {
  if (blobTexture) return blobTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
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

/** Parent to the rig ROOT, not the body — it must not inherit the wingbeat bob. */
export function makeContactBlob(radius: number, drop: number, opacity = 0.34): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2);
  geo.rotateX(-Math.PI / 2); // baked flat so the quaternion work below is pure cancel
  const mat = new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: 0x1a1d16,     // terrain's shadow tint, not pure black
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -drop;
  mesh.renderOrder = -1;
  mesh.userData.blobOpacity = opacity; // base the altitude fade scales
  return mesh;
}

const _q = new THREE.Quaternion();

// Units above the surface. FADE_FROM clears the hover band (1.55 free, 1.3 ridden);
// FADE_TO is ~1s of the 7 u/s climb, so a climbing mount trails no disc (issue #134).
const FADE_FROM = 2.0;
const FADE_TO = 9.0;

// Once per frame from animate(). Drop divides by the root's Y scale (child of a rig
// that mount form rescales), the quaternion cancels root bank, and castShadow is
// cleared because BeastActor set it on every mesh. Omit altitude on a world-less stage.
export function updateContactBlob(
  blob: THREE.Object3D, root: THREE.Object3D, spread: number, altitude?: number,
): void {
  if (altitude !== undefined) {
    const k = altitude <= FADE_FROM ? 1
      : altitude >= FADE_TO ? 0
      : 1 - (altitude - FADE_FROM) / (FADE_TO - FADE_FROM);
    blob.visible = k > 0;
    if (!blob.visible) return;
    const sy = root.scale.y || 1;
    blob.position.y = -altitude / sy;
    const mat = (blob as THREE.Mesh).material as THREE.MeshBasicMaterial;
    mat.opacity = ((blob.userData.blobOpacity as number) ?? mat.opacity) * k;
  }
  blob.quaternion.copy(_q.copy(root.quaternion).invert());
  blob.scale.set(spread, 1, spread);
  const m = blob as THREE.Mesh;
  m.castShadow = false;
  m.receiveShadow = false;
}
