import * as THREE from "three";

/**
 * Cached shadow map for the static half of the world: a rare STATIC pass into our
 * own target (camera masked to STATIC_SHADOW_LAYER), a per-frame DYNAMIC pass into
 * the light's map with that layer masked out, then a fullscreen triangle writing
 * the cached depth under LESS — a depth min of the two halves. A quad rather than
 * `gl.blitFramebuffer`, which needs a three internal that keeps changing shape.
 * STATIC OPTS IN: a missed actor would freeze its shadow into the cache, where a
 * missed piece of scenery merely redraws. Stale when the shadow box moves or
 * resizes (both halves must share one light matrix) or static geometry changes.
 */

/** Cacheable-geometry layer bit; 1 is the first free bit (post.ts owns 11). The
 * camera and any `Raycaster` must enable it or they miss the terrain. */
export const STATIC_SHADOW_LAYER = 1;

/** A change carries its BOUNDS; blanket invalidation cost more than it saved.
 * Cleared every frame: a region only matters once the box moves toward it, and a
 * box that moves rebuilds anyway. `globalDirty` covers changes with no bounds. */
let globalDirty = true;
const pending: THREE.Sphere[] = [];

const _sphere = new THREE.Sphere();

/** ONLY for things that do not move. `enable`/`disable` rather than `set`, so an
 * emissive mesh keeps post.ts's bloom layer 11. */
export function markStaticShadowCaster(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.layers.enable(STATIC_SHADOW_LAYER);
    o.layers.disable(0);
  });
  invalidateStaticShadowsNear(root);
}

/** Rebuilds only if the change can reach the shadow box. Bounds are measured off
 * the geometry; no mesh under it falls through to unbounded, the safe way. */
export function invalidateStaticShadowsNear(root: THREE.Object3D): void {
  let found = false;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) {
      return;
    }
    if (!m.geometry.boundingSphere) {
      m.geometry.computeBoundingSphere();
    }
    const bs = m.geometry.boundingSphere;
    if (!bs) {
      return;
    }
    _sphere.copy(bs).applyMatrix4(m.matrixWorld);
    if (!found) {
      found = true;
      pending.push(new THREE.Sphere().copy(_sphere));
    } else {
      pending[pending.length - 1].union(_sphere);
    }
  });
  if (!found) {
    globalDirty = true;
  }
}

/** Unbounded change. Forces one rebuild. */
export function invalidateStaticShadows(): void {
  globalDirty = true;
}

const _off = new THREE.Vector3();

/** Clears the list either way. Tested IN LIGHT SPACE on the two BOUNDED ortho
 * axes (`x`/`y` = engine.ts's SHADOW_X/Y); the third is depth, i.e. "anywhere". */
function takeDirty(center: THREE.Vector3, s: number, x: THREE.Vector3, y: THREE.Vector3): boolean {
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

// texelFetch, not texture(): a 1:1 copy, and it lets the cache's depth texture
// stay an ordinary sampler2D — a shadow sampler cannot be read for its value.
const QUAD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uStatic;
out vec4 outColor;
void main() {
  gl_FragDepth = texelFetch(uStatic, ivec2(gl_FragCoord.xy), 0).r;
  outColor = vec4(1.0);
}
`;

const _lights: THREE.Light[] = [];

/** Visible casters split by pass, dynamic side named. Whole-graph walk: probe only. */
export function shadowCasterCensus(scene: THREE.Scene): Record<string, unknown> {
  let staticCasters = 0;
  let dynamic = 0;
  const names: Record<string, number> = {};
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.castShadow) {
      return;
    }
    // A hidden ancestor hides this too, and three's shadow pass returns on it.
    for (let p: THREE.Object3D | null = m; p; p = p.parent) {
      if (!p.visible) {
        return;
      }
    }
    if (m.layers.isEnabled(STATIC_SHADOW_LAYER)) {
      staticCasters++;
    } else {
      dynamic++;
      // Nearest named ancestor: an unnamed voxel mesh's group usually is named.
      let key = "";
      for (let p: THREE.Object3D | null = m; p && p !== scene; p = p.parent) {
        if (p.name) {
          key = p.name;
          break;
        }
      }
      if (!key) {
        key = `${m.parent === scene ? "scene/" : ""}${m.type}`;
      }
      names[key] = (names[key] ?? 0) + 1;
    }
  });
  return { staticCasters, dynamic, names };
}

export class StaticShadowCache {
  /** Cached depth in the light's projection. Allocated on first use. */
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.Camera();
  private readonly quadMat: THREE.RawShaderMaterial;
  /** Empty scene: it only supplies a render state for the passes. See `runPasses`. */
  private readonly passScene = new THREE.Scene();
  /** Preallocated, not closed over: an update path allocates nothing. `live`
   * makes a stray `onAfterRender` a no-op. */
  private readonly passArgs = {
    live: false,
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.Camera,
    sun: null as unknown as THREE.DirectionalLight,
    axisX: new THREE.Vector3(),
    axisY: new THREE.Vector3(),
  };

  private cachedExtent = 0;
  private readonly cachedCenter = new THREE.Vector3(NaN, NaN, NaN);
  private hasCache = false;

  /** Reported by `Engine.shadowDebug()` / `__dbgShadows()`. */
  rebuilds = 0;
  frames = 0;
  private rebuiltMoved = 0;
  private rebuiltChanged = 0;

  constructor() {
    this.quadMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uStatic: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      // LESS = nearer caster per texel; nothing reads the colour attachment.
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessDepth,
      colorWrite: false,
    });
    // A fullscreen TRIANGLE: no diagonal seam, one primitive instead of two.
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    const mesh = new THREE.Mesh(g, this.quadMat);
    mesh.frustumCulled = false;
    this.quadScene.add(mesh);
    this.passScene.onAfterRender = () => this.runPasses();
  }

  invalidate(): void {
    this.hasCache = false;
  }

  /**
   * Runs from `Engine.render()` BEFORE the post chain and leaves
   * `shadowMap.needsUpdate` false, so the chain's render() calls cannot redo it.
   * The caller owes an up-to-date `scene.matrixWorld`. The empty-scene render is
   * required: `WebGLShadowMap.render` needs three's `currentRenderState`, which
   * only exists inside a `renderer.render()`.
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

    // Passes 1 and 2. Our own target, so a stray clear cannot reach the canvas.
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

    // Pass 3: cached static depth over the top, under LESS.
    const map = shadow.map;
    if (map) {
      this.quadMat.uniforms.uStatic.value = rt.depthTexture;
      // `LightShadow.map` is typed abstract; three only ever puts a WebGLRenderTarget there.
      renderer.setRenderTarget(map as THREE.WebGLRenderTarget);
      renderer.render(this.quadScene, this.quadCam);
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    // Belt and braces: the post chain must not trigger a fourth pass.
    renderer.shadowMap.needsUpdate = false;
  }

  private runPasses(): void {
    const { live, renderer, scene, camera, sun, axisX, axisY } = this.passArgs;
    if (!live) {
      return;
    }
    const sm = renderer.shadowMap;
    const shadow = sun.shadow;
    const box = shadow.camera;
    const rt = this.rt as THREE.WebGLRenderTarget;

    _lights.length = 0;
    _lights.push(sun);
    const mask = camera.layers.mask;

    // `takeDirty` must run unconditionally — it clears the pending list.
    const moved = this.cachedExtent !== box.right || !this.cachedCenter.equals(sun.target.position);
    const changed = takeDirty(sun.target.position, box.right, axisX, axisY);
    if (!this.hasCache || moved || changed) {
      // Point the light at our target for one call, reusing three's own depth
      // materials, culling and alpha-test permutations.
      const prevMap = shadow.map;
      camera.layers.set(STATIC_SHADOW_LAYER);
      shadow.map = rt;
      sm.needsUpdate = true;
      sm.render(_lights, scene, camera);
      shadow.map = prevMap;
      camera.layers.mask = mask;
      this.hasCache = true;
      this.cachedExtent = box.right;
      this.cachedCenter.copy(sun.target.position);
      this.rebuilds++;
      if (moved) {
        this.rebuiltMoved++;
      }
      if (changed) {
        this.rebuiltChanged++;
      }
    }

    // `disable`, not `set(0)`: other bits must survive or a bloomed mesh stops casting.
    camera.layers.disable(STATIC_SHADOW_LAYER);
    sm.needsUpdate = true;
    sm.render(_lights, scene, camera);
    camera.layers.mask = mask;
  }

  private allocate(w: number, h: number): void {
    this.rt?.depthTexture?.dispose();
    this.rt?.dispose();
    // NearestFilter and a null compareFunction: the quad READS this texture.
    const rt = new THREE.WebGLRenderTarget(w, h);
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.compareFunction = null;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.name = "staticShadowCache";
    rt.depthTexture = depth;
    this.rt = rt;
    this.hasCache = false;
  }

  debug(): Record<string, unknown> {
    return {
      size: this.rt?.width ?? 0,
      rebuilds: this.rebuilds,
      frames: this.frames,
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
      if ((o as THREE.Mesh).geometry) {
        (o as THREE.Mesh).geometry.dispose();
      }
    }
    this.hasCache = false;
  }
}
