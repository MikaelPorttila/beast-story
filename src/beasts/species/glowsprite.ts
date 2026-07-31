import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared soft-halo helper for species files.
//
// HISTORY, and it matters for every number below. This started life as a
// FAKE-bloom helper, written when the sentence "there is no postprocessing bloom
// pass in this game" was true: emissive voxels read as slightly-brighter paint,
// so a glow focal point (flame, lantern, cheek spark, underglow) needed a soft
// radial sprite to sell it. PostFX now has a selective emissive bloom pass
// (src/core/post.ts), and the two have been compounding ever since — the sprite
// blooms, the emissive voxels behind it bloom, and the result is one shapeless
// orb where a shaped glow was intended. Photographed in the real game at
// cam=2.6,2.4,3.0, the Emberfox's tail flame was a featureless warm blob roughly
// the size of the fox's own head, sitting at head height: a critic reading that
// frame reported the fox as "on fire and stuck that way" rather than as fire-typed.
//
// So the sprite's job is now much smaller: take the hard edge off the emissive
// voxels' own bloom, not BE the glow. Keep scales ~0.15-0.25 and opacities
// ~0.05-0.08, and let the voxel shape carry the read. Anything past that and the
// bloom pass amplifies a disc you did not want.
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
