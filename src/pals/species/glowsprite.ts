import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared fake-bloom helper for species files. There is no postprocessing bloom
// pass in this game, so emissive voxels read as slightly-brighter paint. Glow
// focal points (flames, lanterns, cheek sparks, underglows) get a small soft
// radial-gradient sprite instead. Keep scales ~0.3-0.4 and opacities ~0.2-0.3:
// subtle halo, not a blown-out orb.
// ---------------------------------------------------------------------------

let glowTexture: THREE.CanvasTexture | null = null;

/** Lazily build one shared 64px radial-gradient texture (white -> clear). */
function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.15)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

/**
 * A soft glow billboard. Attach it to the rig part that owns the glowing
 * feature so it rides the animation. `blending` defaults to additive (fire /
 * electric / light); pass THREE.NormalBlending for dark creatures whose glow
 * must not wash out.
 */
export function makeGlowSprite(
  color: number,
  scale: number,
  opacity: number,
  blending: THREE.Blending = THREE.AdditiveBlending,
): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color,
    transparent: true,
    opacity,
    blending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale, scale, 1);
  return sprite;
}
