import * as THREE from 'three';

/**
 * A CACHED SHADOW MAP FOR THE HALF OF THE WORLD THAT NEVER MOVES.
 *
 * Every frame used to redraw a 4096^2 depth map from every caster in the
 * streamed world, and almost none of what it redrew had changed: terrain,
 * trees, roads and two settlements are pure functions of the seed and stand
 * exactly where they stood last frame. Only the hero, his followers, the wild
 * spawns and whatever VFX is in flight actually move.
 *
 * So the world's half is rendered ONCE into a cache of its own and composited
 * back:
 *
 *   1. STATIC PASS (rare). Three's own shadow renderer, pointed at our render
 *      target instead of the light's, with the view camera's layer mask set to
 *      STATIC_SHADOW_LAYER so only marked geometry draws.
 *   2. DYNAMIC PASS (every frame). Three's shadow renderer again, into the
 *      light's real map, with that layer masked OUT — so it draws the actors and
 *      nothing else, and clears the map on the way in exactly as it always did.
 *   3. COMPOSITE (every frame). One fullscreen triangle over the light's map
 *      that reads the cached depth and writes it to `gl_FragDepth` under a LESS
 *      test. Depth-buffer min of the two halves, which is what a shadow map is.
 *
 * WHAT IT IS WORTH, MEASURED, and the honest version is not the one the idea
 * promises. Every number below is from `tools/test-shadowcache.mjs`, which
 * A/B/s the cache INSIDE ONE PAGE LOAD, alternating every 2.5 s over the same
 * stretch of world, because two page loads a minute apart on a desktop differ
 * by more than the thing being measured — an early cross-load run "showed" the
 * shadow pass costing 2.15 ms and it was drift plus a second change.
 *
 * On an RTX 3070 Ti at 1280x800, near the spawn:
 *
 *   draw calls    681 -> 572     -109, and the same -109 every run
 *   triangles     3.73M -> 2.66M   -29%
 *   frame cpu     -0.18 to -0.26 ms standing (paired means, 5/6 and 9/12
 *                 alternations cheaper); -0.05 ms walking, i.e. inside the noise
 *
 * A hundred draw calls for a fifth of a millisecond IS what a draw submission
 * costs on a fast desktop, and it is the number that travels worst: on a machine
 * where a draw call is expensive — an integrated GPU, a phone — the same 109
 * calls are worth several times that. Read it as a floor, not a headline.
 *
 * THE OTHER HALF OF THIS CHANGE IS WORTH MORE THAN THE CACHE IS, which is worth
 * saying plainly because it was found by accident while building this. Running
 * the shadow passes here means running them BEFORE the post chain, which means
 * the scene's world matrices have to be updated before them — so `Engine`
 * hoisted `scene.updateMatrixWorld()` out of `renderer.render()`
 * (`scene.matrixWorldAutoUpdate = false`) and calls it once. A frame makes four
 * render() calls and only one of them could ever have anything to recompute.
 * Measured the same way: **-0.46 ms standing, -0.58 ms walking**, and unanimous
 * across every alternation. Together the pair is -0.72 / -0.64 ms of a 5-6 ms
 * frame, 11-12%, and THAT is unanimous where neither half alone is.
 *
 * WHY A COMPOSITE QUAD AND NOT A DEPTH BLIT. `gl.blitFramebuffer` would copy the
 * cached depth in hardware for nothing, and it is the better primitive — but
 * getting the two framebuffer handles means `renderer.properties.get(rt)
 * .__webglFramebuffer`, an internal that has changed shape more than once (cube
 * targets, multisample, multiview). The quad is public API end to end and reads
 * one texel per texel, which measured inside the noise. If that ever stops being
 * true, the blit is the upgrade — the composition rule does not change.
 *
 * WHY THE STATIC SIDE IS THE ONE THAT OPTS IN. The layer split could be written
 * either way round, and the direction decides what a MISSED object does. Marked
 * static, a missed actor freezes its shadow in the cache and drags a black
 * smear around behind it — a bug a player sees. Marked dynamic (the default
 * here, i.e. "not marked"), a missed piece of scenery is simply redrawn every
 * frame: correct, just not free. Only `markStaticShadowCaster` moves anything,
 * and only world geometry calls it.
 *
 * WHAT MAKES THE CACHE STALE. Exactly three things, and they are all the same
 * thing: anything that changes what the cached depth MEANS.
 *   - the shadow box moved or resized (Engine.updateSunFocus — the cache and the
 *     live map must share one light matrix or the composite is nonsense);
 *   - static geometry was added or removed (a chunk streamed in, a chunk went
 *     away);
 *   - static geometry changed visibility (the F3 grass/trees rows, a zone
 *     handover hiding the overworld).
 * The last two arrive as `invalidateStaticShadowsNear()`, module-level rather
 * than a method on this class, because the callers are world code that has no
 * reason to know an engine exists.
 */

/**
 * Layer bit for geometry the cache is allowed to bake.
 *
 * 1 rather than anything larger because it is the first free bit — post.ts's
 * selective bloom already owns 11. It is a real layer, so THE CAMERA HAS TO
 * ENABLE IT (Engine's constructor does) and so does anything that raycasts the
 * scene: a `Raycaster` starts on layer 0 alone and would otherwise walk straight
 * through the terrain it is asking about.
 */
export const STATIC_SHADOW_LAYER = 1;

/**
 * Static geometry changed somewhere, and WHERE is the whole question.
 *
 * A cache that rebuilt on every change would rebuild several times a second and
 * be worse than no cache at all: the streamer builds a chunk stage or two every
 * frame the hero walks, and unloads one behind him — measured, a blanket
 * invalidation gave 13.2 frames per rebuild and cost 0.9 ms of frame where it
 * was meant to save 2. But almost none of that work is anywhere near the shadow
 * box: chunks arrive at the streaming ring, ~160 units out, and the box is 72
 * units of half-extent around the hero. A chunk that cannot project into the
 * box cannot change one texel of it.
 *
 * So a change carries its bounds, and `update()` asks the box about them. The
 * pending list is CLEARED EVERY FRAME whether or not it triggered anything, and
 * that is safe rather than sloppy: a region only becomes relevant to the box by
 * the box MOVING toward it, and a box that moves rebuilds anyway.
 *
 * `globalDirty` is the escape hatch for a change with no sensible bounds — the
 * F3 layer rows, a zone handover hiding the overworld — and for the first frame.
 */
let globalDirty = true;
const pending: THREE.Sphere[] = [];

const _sphere = new THREE.Sphere();

/**
 * Mark a subtree as static shadow geometry: cached, and redrawn only when
 * something invalidates the cache.
 *
 * `enable` then `disable` rather than `set`, because layer 11 may already be on
 * an emissive mesh (post.ts's selective bloom sweeps for those every frame) and
 * `set` would wipe it — a lamp that stopped glowing the moment the shadow cache
 * shipped would have been an entertaining bug to chase.
 *
 * ONLY FOR THINGS THAT DO NOT MOVE. Not the shop crystals (they bob and spin),
 * not Gain (he curls a dumbbell), not a beast, not a VFX mesh. A moving caster
 * marked static gets its shadow printed into the cache and left there.
 */
export function markStaticShadowCaster(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.layers.enable(STATIC_SHADOW_LAYER);
    o.layers.disable(0);
  });
  invalidateStaticShadowsNear(root);
}

/**
 * Static geometry appeared, vanished or moved AT this object — the cache
 * rebuilds only if it can reach the shadow box.
 *
 * The bounds are measured off the geometry that is there, so a caller never
 * writes a radius down: a chunk knows how big a chunk is by being one. Anything
 * with no mesh under it (or no bounding sphere yet) falls through to the
 * unbounded form, which is the safe direction.
 */
export function invalidateStaticShadowsNear(root: THREE.Object3D): void {
  let found = false;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const bs = m.geometry.boundingSphere;
    if (!bs) return;
    _sphere.copy(bs).applyMatrix4(m.matrixWorld);
    if (!found) {
      found = true;
      pending.push(new THREE.Sphere().copy(_sphere));
    } else {
      pending[pending.length - 1].union(_sphere);
    }
  });
  if (!found) globalDirty = true;
}

/** Static geometry changed somewhere unbounded. Forces one rebuild. */
export function invalidateStaticShadows(): void {
  globalDirty = true;
}

const _off = new THREE.Vector3();

/**
 * Does anything on the pending list reach a shadow box of half-extent `s`
 * centred at `center`? Clears the list either way — see the note on `pending`.
 *
 * The test is done IN LIGHT SPACE, against the two axes the ortho box is
 * bounded on, and that is worth the two dot products: the third axis is DEPTH,
 * which spans 260 units and effectively means "anywhere". A 3D world-distance
 * test was tried first and folds that axis back in, so it kept a chunk arriving
 * at the streaming ring — 160 units away and squarely behind the camera —
 * inside the reach of a 72-unit box. Measured over one straight walk, that is
 * 97 rebuilds against 35 that the box actually moved for.
 *
 * `x` and `y` here are `SHADOW_X`/`SHADOW_Y` from engine.ts, passed in rather
 * than imported: the axes are the light's, and this module never sees the light
 * anywhere else.
 */
function takeDirty(
  center: THREE.Vector3, s: number, x: THREE.Vector3, y: THREE.Vector3,
): boolean {
  let dirty = globalDirty;
  if (!dirty) {
    for (const sp of pending) {
      _off.subVectors(sp.center, center);
      const reach = s + sp.radius;
      if (Math.abs(_off.dot(x)) <= reach && Math.abs(_off.dot(y)) <= reach) {
        dirty = true;
        break;
      }
    }
  }
  globalDirty = false;
  pending.length = 0;
  return dirty;
}

const QUAD_VERT = /* glsl */ `
precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

// texelFetch, not texture(): this is a 1:1 copy between two maps of identical
// size, so there is exactly one right source texel and no filtering to want. It
// also means the cache's depth texture can keep NearestFilter and a null
// compareFunction and be read as an ordinary sampler2D — a shadow sampler
// (which is what three configures the LIVE map's depth texture as) cannot be
// read for its value at all.
const QUAD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uStatic;
out vec4 outColor;
void main() {
  gl_FragDepth = texelFetch(uStatic, ivec2(gl_FragCoord.xy), 0).r;
  outColor = vec4(1.0);
}
`;

/** Reused by `update()`; three's shadow renderer takes an array. */
const _lights: THREE.Light[] = [];

/**
 * Every visible shadow caster in the scene, split by which pass draws it, and
 * the dynamic side named so a mesh that should have been marked can be found.
 *
 * Walks the whole scene graph — a probe, never a frame. This is what turns "the
 * dynamic pass is drawing 126 things" from a mystery into a list.
 */
export function shadowCasterCensus(scene: THREE.Scene): Record<string, unknown> {
  let staticCasters = 0;
  let dynamic = 0;
  const names: Record<string, number> = {};
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.castShadow) return;
    // A hidden ancestor hides this too, and three's shadow pass returns on it.
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
    if (m.layers.isEnabled(STATIC_SHADOW_LAYER)) {
      staticCasters++;
    } else {
      dynamic++;
      // Named by the nearest ancestor that HAS a name, up to the scene: an
      // unnamed voxel mesh is anonymous, but the group somebody added it to
      // rarely is, and that is enough to find the file it came from.
      let key = '';
      for (let p: THREE.Object3D | null = m; p && p !== scene; p = p.parent) {
        if (p.name) { key = p.name; break; }
      }
      if (!key) key = `${m.parent === scene ? 'scene/' : ''}${m.type}`;
      names[key] = (names[key] ?? 0) + 1;
    }
  });
  return { staticCasters, dynamic, names };
}

export class StaticShadowCache {
  /** The cached depth, in the light's projection. Allocated on first use. */
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.Camera();
  private readonly quadMat: THREE.RawShaderMaterial;
  /**
   * An EMPTY scene, rendered for no pixels, whose only job is to give three a
   * render state to run the shadow passes inside. See `runPasses`.
   */
  private readonly passScene = new THREE.Scene();
  /**
   * What `runPasses` needs, parked here for the length of one render call.
   *
   * A preallocated record, assigned into, rather than a closure over `update`'s
   * arguments or a fresh literal: both would be a per-frame allocation, which
   * is the one thing an update path in this codebase may not do. `live` is what
   * makes a stray `onAfterRender` a no-op rather than a crash.
   */
  private readonly passArgs = {
    live: false,
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.Camera,
    sun: null as unknown as THREE.DirectionalLight,
    axisX: new THREE.Vector3(),
    axisY: new THREE.Vector3(),
  };

  /** What the cache in `rt` was rendered with. */
  private cachedExtent = 0;
  private readonly cachedCenter = new THREE.Vector3(NaN, NaN, NaN);
  private hasCache = false;

  /** Reported by `Engine.shadowDebug()` / `__dbgShadows()`. */
  rebuilds = 0;
  frames = 0;
  /** Split of `rebuilds` by cause — the two that a tuning run needs apart. */
  private rebuiltMoved = 0;
  private rebuiltChanged = 0;

  constructor() {
    this.quadMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uStatic: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      // LESS against whatever the dynamic pass left, so the result is the
      // nearer of the two casters per texel. colorWrite off because the light
      // samples the depth texture and nothing ever reads the colour attachment
      // — three clears it to white and that is the end of it.
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessDepth,
      colorWrite: false,
    });
    // A fullscreen TRIANGLE, not a quad: no diagonal seam to get the
    // interpolation wrong on, and one primitive instead of two.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3,
    ));
    const mesh = new THREE.Mesh(g, this.quadMat);
    mesh.frustumCulled = false;
    this.quadScene.add(mesh);
    // Bound ONCE. See `passArgs` for why this is not a closure per frame.
    this.passScene.onAfterRender = () => this.runPasses();
  }

  /** Force a rebuild on the next frame — shadows toggled, map resized, … */
  invalidate(): void {
    this.hasCache = false;
  }

  /**
   * Render the frame's shadow map: cached static half plus a live dynamic half.
   *
   * Called from `Engine.render()` BEFORE the post chain, and it leaves
   * `renderer.shadowMap.needsUpdate` false so the several `renderer.render()`
   * calls the chain makes cannot redo any of it — the same contract the plain
   * `needsUpdate = true` it replaced had.
   *
   * The caller owes it an up-to-date `scene.matrixWorld`: three normally does
   * that at the top of `render()`, and this runs before any of those.
   *
   * TWO renderer.render() CALLS ON SCENES OF NOTHING, and the first of them is
   * not optional. `WebGLShadowMap.render` reads three's `currentRenderState`,
   * which only exists for the duration of a `renderer.render()` — call it from
   * outside one and it throws on `null.state` before it draws a thing. So the
   * passes are run from an empty scene's `onAfterRender`, which is the last hook
   * that still has that state (three pops it two statements later). The empty
   * scene projects no objects, sets up no lights and draws no pixels; measured,
   * the pair is inside the frame-to-frame noise.
   */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    sun: THREE.DirectionalLight,
    axisX: THREE.Vector3,
    axisY: THREE.Vector3,
  ): void {
    const shadow = sun.shadow;
    const mapW = shadow.mapSize.x;
    const mapH = shadow.mapSize.y;
    if (!this.rt || this.rt.width !== mapW || this.rt.height !== mapH) {
      this.allocate(mapW, mapH);
    }
    const rt = this.rt as THREE.WebGLRenderTarget;
    this.frames++;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // Pass 1 and 2, inside a render state. The target is our own so that a
    // stray clear can never reach the canvas; `sm.render` saves and restores it
    // around each pass anyway.
    const a = this.passArgs;
    a.live = true;
    a.renderer = renderer;
    a.scene = scene;
    a.camera = camera;
    a.sun = sun;
    a.axisX.copy(axisX);
    a.axisY.copy(axisY);
    renderer.setRenderTarget(rt);
    renderer.render(this.passScene, this.quadCam);
    a.live = false;

    // Pass 3: the cached static depth, over the top, under a LESS test.
    const map = shadow.map;
    if (map) {
      this.quadMat.uniforms.uStatic.value = rt.depthTexture;
      // `LightShadow.map` is typed as the abstract RenderTarget; three only ever
      // puts a WebGLRenderTarget there (and we hand it one ourselves above).
      renderer.setRenderTarget(map as THREE.WebGLRenderTarget);
      renderer.render(this.quadScene, this.quadCam);
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    // Belt and braces: `sm.render` clears this itself, and the post chain must
    // not be able to trigger a fourth pass whatever happens above.
    renderer.shadowMap.needsUpdate = false;
  }

  /** The two depth passes. Runs inside a render state; see `update`. */
  private runPasses(): void {
    const { live, renderer, scene, camera, sun, axisX, axisY } = this.passArgs;
    if (!live) return;
    const sm = renderer.shadowMap;
    const shadow = sun.shadow;
    const box = shadow.camera;
    const rt = this.rt as THREE.WebGLRenderTarget;

    _lights.length = 0;
    _lights.push(sun);
    const mask = camera.layers.mask;

    // `takeDirty` must run unconditionally — it is what clears the pending
    // list, and a `||` that short-circuited past it would leave a region on the
    // list to re-fire next frame.
    const moved = this.cachedExtent !== box.right
      || !this.cachedCenter.equals(sun.target.position);
    const changed = takeDirty(sun.target.position, box.right, axisX, axisY);
    if (!this.hasCache || moved || changed) {
      // Three renders into `shadow.map` and clears it first, so pointing the
      // light at our target for the length of one call is the whole trick —
      // no fork of its depth-material handling, its frustum culling or its
      // alpha-test permutations, all of which the streamed world uses.
      const live = shadow.map;
      camera.layers.set(STATIC_SHADOW_LAYER);
      shadow.map = rt;
      sm.needsUpdate = true;
      sm.render(_lights, scene, camera);
      shadow.map = live;
      camera.layers.mask = mask;
      this.hasCache = true;
      this.cachedExtent = box.right;
      this.cachedCenter.copy(sun.target.position);
      this.rebuilds++;
      if (moved) this.rebuiltMoved++;
      if (changed) this.rebuiltChanged++;
    }

    // The actors. `disable`, not `set(0)` — the mask has to keep every other
    // bit the scene uses or a bloomed VFX mesh would stop casting.
    camera.layers.disable(STATIC_SHADOW_LAYER);
    sm.needsUpdate = true;
    sm.render(_lights, scene, camera);
    camera.layers.mask = mask;
  }

  private allocate(w: number, h: number): void {
    this.rt?.depthTexture?.dispose();
    this.rt?.dispose();
    // Same shape three gives a PCF shadow map, with two deliberate differences:
    // NearestFilter and a null compareFunction, because this texture is READ
    // (by the composite quad) rather than compared against. The colour
    // attachment is along for the ride — three clears it and nothing samples it.
    const rt = new THREE.WebGLRenderTarget(w, h);
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.compareFunction = null;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.name = 'staticShadowCache';
    rt.depthTexture = depth;
    this.rt = rt;
    this.hasCache = false;
  }

  debug(): Record<string, unknown> {
    return {
      size: this.rt?.width ?? 0,
      rebuilds: this.rebuilds,
      frames: this.frames,
      /** Frames per rebuild — the whole point of the thing, in one number. */
      perRebuild: this.rebuilds > 0 ? +(this.frames / this.rebuilds).toFixed(1) : 0,
      rebuiltMoved: this.rebuiltMoved,
      rebuiltChanged: this.rebuiltChanged,
      valid: this.hasCache,
      extent: this.cachedExtent,
    };
  }

  dispose(): void {
    this.rt?.depthTexture?.dispose();
    this.rt?.dispose();
    this.rt = null;
    this.quadMat.dispose();
    for (const o of this.quadScene.children) {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
    }
    this.hasCache = false;
  }
}
