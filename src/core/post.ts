import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Post-processing stack. Owned by Engine; nothing else needs to know it exists.
 *
 * Order matters and is deliberate:
 *
 *   RenderPass   scene -> linear HDR half-float buffer. Because the target is a
 *                render target and not the canvas, three does NOT apply tone
 *                mapping here (see WebGLPrograms: toneMapping is forced to
 *                NoToneMapping whenever currentRenderTarget !== null), so every
 *                pass below works on scene-referred linear values.
 *   GTAOPass     ground-truth ambient occlusion multiplied into that linear
 *                buffer, i.e. before anything additive is layered on, so the AO
 *                darkens surfaces and never the glow sitting in front of them.
 *                It is deliberately a WIDE CONTACT term, not a crevice term —
 *                see the pass for why screen-space AO geometrically cannot find
 *                a voxel seam here.
 *   bloom        selective: only objects tagged as emissive contribute (see
 *                EmissiveBloomPass). Still linear/HDR, still pre-tonemap — a
 *                bloom applied after the tone curve looks like a smeared JPEG.
 *   output       highlight rolloff -> ACES -> sRGB -> filmic grade, in ONE pass
 *                (see TonemapGradeShader). It used to be three's OutputPass plus
 *                a separate grade ShaderPass; merging them removes a fullscreen
 *                round trip and, more importantly, lets the hue-preserving
 *                highlight rolloff run in the same shader as the tone curve it
 *                exists to protect.
 *   SMAAPass     antialiasing, dead last. `antialias: true` on the renderer is
 *                MSAA on the default framebuffer and does nothing once we draw
 *                into a render target, so without this every cube edge is a
 *                staircase.
 *
 * URL overrides (iteration aid, all optional):
 *   post=0        bypass the whole stack (Engine falls back to renderer.render)
 *   ao=<0..2>     AO blend intensity (0 disables the pass entirely)
 *   aor=<n>       AO reach: world units, or hundreds of AO-buffer pixels if aoss=1
 *   aos=<n>       AO darkening exponent
 *   aot=<n>       AO occluder thickness, world units
 *   aoq=<1|2|4>   AO resolution divisor (1 = full res)
 *   aoss=1        screen-space instead of world-space AO radius
 *   aoview=1      show the denoised AO buffer instead of the picture
 *   bloom=<0..3>  bloom strength (0 disables the pass entirely)
 *   sbloom=<n>    how much the HDR scene's own highlights bloom, sbt=<n> the
 *                 linear threshold above which they start
 *   roll=<n>      highlight rolloff knee, linear radiance (0 = no rolloff)
 *   grade=0       skip the filmic grade (tone map + encode still happen)
 *   aa=0          skip SMAA
 */

/**
 * Objects on this layer, and only these, feed the bloom. Layer 11 is far above
 * anything gameplay uses, and enabling it is additive — an object stays on
 * layer 0 too, so normal rendering and shadow casting are untouched.
 */
const BLOOM_LAYER = 11;

/**
 * Live renderer load, split scene vs. post. The F2 overlay reads this so the
 * draw-call figure stays honest now that one frame issues several passes.
 * A module singleton because DebugOverlay is constructed by main.ts/lab.ts,
 * which never see the PostFX instance.
 */
export const postStats = {
  /** Draw calls issued by the scene render itself (excludes post passes). */
  sceneCalls: 0,
  /** Triangles in the scene render. */
  sceneTris: 0,
  /** Enabled passes in the composer. */
  passes: 0,
  /** Meshes currently tagged as bloom sources. */
  bloomObjects: 0,
};

// ---------------------------------------------------------------------------
// Selective bloom
// ---------------------------------------------------------------------------

/**
 * Why not a plain threshold bloom: every glowing thing in this game is authored
 * in LDR — additive sprites and MeshBasicMaterial cores sit around 0.6 linear
 * luminance, which is *below* sunlit sand (~0.68) and barely above sunlit grass
 * (~0.35 with the current sun). No luminance threshold separates a lantern from
 * a beach, so a threshold bloom either misses the lantern or fogs the whole
 * world. Rendering a second, emissive-only pass is the only clean split.
 *
 * The usual tradeoff of that approach is that the emissive pass has no occluders,
 * so glows shine straight through solid geometry — and it was NOT subtle: a pal's
 * flame behind a terrain cube printed a soft bright smudge on the middle of the
 * cube's shadowed face, which reads as a rendering bug.
 *
 * The fix costs nothing. GTAOPass already rebuilt a depth texture of the opaque
 * scene this frame, so we borrow it as our depth attachment and clear colour
 * only. Glows then depth-test against real geometry without a single extra draw
 * call. That is why this pass shares the AO pass's resolution divisor: a depth
 * attachment of a different size than the colour attachment is an incomplete
 * framebuffer. If AO is switched off the pass falls back to its own depth buffer
 * and the bleed-through returns — documented, and ?ao=0 is a debug path.
 */
const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 9-tap separable Gaussian. The weights sum to 1 so a white source stays white
// instead of gaining energy at every mip (a common source of runaway bloom).
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tSrc, vUv) * 0.2270270;
  c += (texture2D(tSrc, vUv + uStep) + texture2D(tSrc, vUv - uStep)) * 0.1945946;
  c += (texture2D(tSrc, vUv + uStep * 2.0) + texture2D(tSrc, vUv - uStep * 2.0)) * 0.1216216;
  c += (texture2D(tSrc, vUv + uStep * 3.0) + texture2D(tSrc, vUv - uStep * 3.0)) * 0.0540541;
  c += (texture2D(tSrc, vUv + uStep * 4.0) + texture2D(tSrc, vUv - uStep * 4.0)) * 0.0162162;
  gl_FragColor = c;
}
`;

/**
 * Bloom source prep, one fullscreen quad at source resolution. Two jobs.
 *
 * 1. HIGHLIGHT ROLLOFF, and it is the fix for the "flat white plate" failure.
 *    Emberfox's flame core renders at ~4 linear. Blur that and the halo is 4
 *    linear too, ACES clips it, and the flame becomes a white rectangle with no
 *    colour or shape. A Reinhard compression applied as a single scalar taken
 *    from the MAX channel — not per channel — squashes 4.0 down to ~1.3 while
 *    leaving the r:g:b ratio untouched, so the halo stays orange no matter how
 *    hot the source is. Per-channel Reinhard would have pulled r toward g and
 *    b and re-created the whitening it is meant to prevent.
 *
 * 2. SCENE HIGHLIGHTS. The selective pass alone means a lantern blooms and
 *    nothing else in the world does, which is why the daylight read flat. A
 *    soft-knee bright pass over the already-rendered HDR scene adds the missing
 *    half: water specular and sunlit cloud tops pick up a faint halo. The
 *    threshold is deliberately just above sunlit sand so ordinary lit ground
 *    never contributes — that is the milky global wash — and the knee is squared
 *    so the onset is a fade rather than an edge.
 *
 *    THE SKY MUST BE EXCLUDED and it is not optional. The dome is a raw
 *    ShaderMaterial writing 0.5-1.5 linear, i.e. the brightest thing in the
 *    buffer by a wide margin and above any threshold that leaves ground pixels
 *    alone. Left in, a camera facing the sun washed the entire lower half of the
 *    sky to a flat near-white sheet. Depth is the discriminator: sky pixels never
 *    wrote depth, so they sit at exactly 1.0. The depth texture is the one
 *    borrowed from the AO pass, so with ?ao=0 the mask is unavailable and the
 *    scene term is switched off rather than left to wash the sky.
 */
const BLOOM_PREP_FRAG = /* glsl */ `
uniform sampler2D tEmissive;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform float uThreshold;
uniform float uKnee;
uniform float uSceneAmount;
uniform float uRoll;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tEmissive, vUv).rgb;

  // 0.9995, not 1.0: the far ridgeline sits within a hair of the far plane and a
  // hard == 1.0 test left a one-pixel bright fringe along every horizon edge.
  if (uSceneAmount > 0.0 && texture2D(tDepth, vUv).x < 0.9995) {
    vec3 s = texture2D(tScene, vUv).rgb;
    float l = max(max(s.r, s.g), s.b);
    float k = clamp((l - uThreshold) / uKnee, 0.0, 1.0);
    c += s * (k * k) * uSceneAmount;
  }

  float m = max(max(c.r, c.g), c.b);
  c *= 1.0 / (1.0 + m * uRoll);

  gl_FragColor = vec4(c, 1.0);
}
`;

// Weighted sum of the mip chain, blended additively over the scene. uRadius
// biases energy from the tight mips toward the wide ones (Unreal's trick): 0 is
// a compact core glow, 1 is a broad atmospheric halo.
//
// MAX_MIPS taps are declared but only `uCount` of them are summed, because the
// chain length varies with the source resolution (see EmissiveBloomPass.mips).
// Unused samplers are bound to the last live mip so no sampler is left null.
const MAX_MIPS = 6;
const BLOOM_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D t0;
uniform sampler2D t1;
uniform sampler2D t2;
uniform sampler2D t3;
uniform sampler2D t4;
uniform sampler2D t5;
uniform float uStrength;
uniform float uRadius;
uniform int uCount;
varying vec2 vUv;
// NOTE the degenerate point: mix(f, 1.2 - f, 0.5) is 0.6 for every f, i.e. a
// uRadius of exactly 0.5 makes the weights uniform and the knob does nothing.
// Stay clearly below it to actually favour the tight mips.
float w(float i, float n) {
  float f = 1.0 - i / n;                 // 1.0 at the tightest mip, ~0.2 at the widest
  return mix(f, 1.2 - f, uRadius);
}
void main() {
  float n = float(uCount);
  vec3 c = vec3(0.0);
  c += w(0.0, n) * texture2D(t0, vUv).rgb;
  c += w(1.0, n) * texture2D(t1, vUv).rgb;
  if (uCount > 2) c += w(2.0, n) * texture2D(t2, vUv).rgb;
  if (uCount > 3) c += w(3.0, n) * texture2D(t3, vUv).rgb;
  if (uCount > 4) c += w(4.0, n) * texture2D(t4, vUv).rgb;
  if (uCount > 5) c += w(5.0, n) * texture2D(t5, vUv).rgb;
  gl_FragColor = vec4(c * uStrength, 1.0);
}
`;

class EmissiveBloomPass extends Pass {
  strength: number;
  radius: number;

  private src: THREE.WebGLRenderTarget;
  private prep: THREE.WebGLRenderTarget;
  private horiz: THREE.WebGLRenderTarget[] = [];
  private vert: THREE.WebGLRenderTarget[] = [];
  private prepMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  /**
   * Blur levels. The widest level has to stay at roughly a 32nd of the FINAL
   * image however coarse the source is, or the halo's screen size changes with
   * the AO resolution the source inherits — so one extra level per halving.
   */
  private mips: number;

  private savedClear = new THREE.Color();
  private black = new THREE.Color(0, 0, 0);
  private tagged = 0;
  /** True when src borrows the AO pass's depth, so we must not clear depth. */
  private sharedDepth: boolean;
  /** Reused per frame by tagSources(); a Frustum allocates on every setter. */
  private frustum = new THREE.Frustum();
  private frustumMat = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    width: number,
    height: number,
    strength = 0.85,
    radius = 0.72,
    depthTexture: THREE.DepthTexture | null = null,
    threshold = 0.80,
    sceneAmount = 1.2,
    /**
     * Resolution divisor. Must match the AO pass's when its depth texture is
     * borrowed (below) — a depth attachment of a different size than the colour
     * attachment is an incomplete framebuffer.
     */
    private div = 2,
  ) {
    super();
    this.strength = strength;
    this.radius = radius;
    // We blend additively straight onto the read buffer, so the composer must
    // not swap after us.
    this.needsSwap = false;

    // The bloom source is only ever blurred, so a reduced resolution costs
    // nothing visible and quarters the fill for the whole chain. It also has to
    // match the AO buffer size exactly, because that is where the borrowed depth
    // comes from — hence the shared divisor.
    this.mips = Math.max(2, Math.min(MAX_MIPS, 6 - Math.round(Math.log2(div))));
    let w = Math.max(1, Math.round(width / div));
    let h = Math.max(1, Math.round(height / div));
    this.sharedDepth = depthTexture !== null;
    this.src = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      ...(depthTexture ? { depthTexture } : {}),
    });
    this.src.texture.name = 'EmissiveBloom.src';
    // No depth on prep: it is a pure fullscreen transform of src.
    this.prep = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: false,
    });
    for (let i = 0; i < this.mips; i++) {
      const o = { type: THREE.HalfFloatType, depthBuffer: false };
      this.horiz.push(new THREE.WebGLRenderTarget(w, h, o));
      this.vert.push(new THREE.WebGLRenderTarget(w, h, o));
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }

    this.prepMat = new THREE.ShaderMaterial({
      uniforms: {
        tEmissive: { value: this.src.texture },
        tScene: { value: null },
        tDepth: { value: depthTexture },
        // Linear radiance, MEASURED not derived — and do not derive it, because
        // the obvious arithmetic is wrong by a factor of pi. three's diffuse BRDF
        // carries the 1/pi, so a "2.45 intensity" sun does not put a white surface
        // anywhere near 2.45: sunlit grass sits near 0.35 and sunlit sand near
        // 0.68. A first pass at a threshold of 1.62, reasoned from the light
        // intensities, was above every pixel in the game and the whole term did
        // nothing (verified: sbloom=8 was indistinguishable from sbloom=0).
        //
        // 0.80 sits just above sunlit sand and just below the cloud deck's tops
        // (which carry their own near-white emissive on top of albedo) and well
        // below water specular. Swept at 0.60/0.80/1.00 against the wide vista:
        // 0.60 begins to bloom the beach itself, 1.00 catches almost nothing.
        uThreshold: { value: threshold },
        uKnee: { value: 0.55 },
        // The squared knee means a cloud top passes only ~30% of its value, so
        // this is above 1 and still subtle. It is what makes the daylight feel
        // warm rather than merely bright; raising the threshold instead of easing
        // this off is the wrong trade — it just switches the effect back off.
        // Zero without a depth texture to mask the sky with — see the shader.
        uSceneAmount: { value: depthTexture ? sceneAmount : 0 },
        uRoll: { value: 0.55 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLOOM_PREP_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    const tap = (i: number): { value: THREE.Texture } =>
      ({ value: this.vert[Math.min(i, this.mips - 1)].texture });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        t0: tap(0), t1: tap(1), t2: tap(2), t3: tap(3), t4: tap(4), t5: tap(5),
        uStrength: { value: strength },
        uRadius: { value: radius },
        uCount: { value: this.mips },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLOOM_COMPOSITE_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.blurMat);
  }

  /**
   * Decide, per material, what counts as a glow source. Runs every frame so
   * transient emissives (the red hit flash pals get) light up too.
   *
   * The one thing that must NOT get in is the cloud deck. Cloud voxels carry a
   * near-white emissive (`0xf7fafc`) purely as a diffuse brightener, and clouds
   * cover a third of a vista, so blooming them is precisely the milky wash this
   * pass exists to avoid.
   *
   * An intensity floor is the obvious filter and it is the wrong one — it broke
   * once already. It was set at 0.75 against then-current values, and when the
   * art passes retuned every glow downward (emberfox flame 1.8 -> 1.0, lumimoth
   * lantern 0.9 -> 0.5) the floor silently switched the lantern and half the
   * flame off. Chroma is the property that actually distinguishes the two cases
   * and nobody is going to retune it: every deliberate glow here is a coloured
   * one (linear max-min from 0.31 for sparkit's near-white spark core up to 0.87
   * for the flame), while the cloud emissive sits at 0.042. A wide margin either
   * side of a 0.12 cut, with only a token intensity floor to skip decorative
   * specks.
   *
   * Sprites are excluded from the "basic material" rule on purpose: damage
   * numbers and enemy HP bars are `toneMapped: false` sprites, i.e. UI, and a
   * blooming damage number looks like a bug.
   *
   * Finally, an off-screen glow is tagged out again. The renderer would frustum
   * cull it anyway, but only after it has been sorted into a render list and
   * counted, and the F2 overlay was reporting ~78 glow objects for the two or
   * three actually visible — the whole world's shop crystals and lanterns. The
   * sphere test below is the same one the renderer does, run once per frame here
   * so the number on the overlay is the truth.
   */
  private tagSources(): void {
    let n = 0;
    this.frustum.setFromProjectionMatrix(
      this.frustumMat.multiplyMatrices(
        this.camera.projectionMatrix, this.camera.matrixWorldInverse,
      ),
    );
    this.scene.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const m = Array.isArray(mat) ? mat[0] : mat;
      if (!m) return;

      // Opt-out for additive things whose halo is authored by hand rather than
      // blurred (the sun disk — see engine.ts).
      if (obj.userData.cpNoBloom === true) {
        if (obj.layers.isEnabled(BLOOM_LAYER)) obj.layers.disable(BLOOM_LAYER);
        return;
      }

      let glows = m.blending === THREE.AdditiveBlending;
      if (!glows) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.emissive !== undefined && (std.emissiveIntensity ?? 0) >= 0.30) {
          const e = std.emissive;
          glows = Math.max(e.r, e.g, e.b) - Math.min(e.r, e.g, e.b) > 0.12;
        }
      }
      if (!glows && (m as THREE.MeshBasicMaterial).isMeshBasicMaterial && m.toneMapped === false) {
        glows = !(obj as THREE.Sprite).isSprite;
      }

      if (glows && obj.visible) {
        const geo = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (geo && obj.frustumCulled) {
          if (geo.boundingSphere === null) geo.computeBoundingSphere();
          const bs = geo.boundingSphere;
          if (bs) {
            this.sphere.copy(bs).applyMatrix4(obj.matrixWorld);
            if (!this.frustum.intersectsSphere(this.sphere)) glows = false;
          }
        }
      }

      if (glows) {
        obj.layers.enable(BLOOM_LAYER);
        n++;
      } else if (obj.layers.isEnabled(BLOOM_LAYER)) {
        obj.layers.disable(BLOOM_LAYER);
      }
    });
    this.tagged = n;
    postStats.bloomObjects = n;
  }

  /** Draw the tagged objects alone onto black. */
  private renderSource(renderer: THREE.WebGLRenderer): void {
    const bg = this.scene.background;
    const fog = this.scene.fog;
    const mask = this.camera.layers.mask;
    renderer.getClearColor(this.savedClear);
    const alpha = renderer.getClearAlpha();

    // No sky and no fog in the source pass: a fogged lantern would bloom in the
    // fog's colour, and the sky dome would flood every pixel.
    this.scene.background = null;
    this.scene.fog = null;
    this.camera.layers.set(BLOOM_LAYER);

    renderer.setRenderTarget(this.src);
    renderer.setClearColor(this.black, 1);
    // Colour only when the depth is borrowed from the AO pass — clearing it would
    // throw away the very occluders we came for.
    renderer.clear(true, !this.sharedDepth, false);
    // Nothing on screen glows: the clear above is the whole source, so skip the
    // draw. The rest of the chain still runs, because the scene-highlight term in
    // the prep pass must not switch itself off when the last lantern leaves the
    // frame — that would pop the daylight bloom on and off as the player walks.
    if (this.tagged > 0) renderer.render(this.scene, this.camera);

    this.camera.layers.mask = mask;
    this.scene.background = bg;
    this.scene.fog = fog;
    renderer.setClearColor(this.savedClear, alpha);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.tagSources();

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.renderSource(renderer);

    // Prep: emissives + a soft-knee bright pass over the HDR scene, then the
    // hue-preserving rolloff. Everything downstream sees compressed values, so
    // no amount of emissive intensity can turn the halo white.
    this.prepMat.uniforms.tScene.value = readBuffer.texture;
    this.quad.material = this.prepMat;
    renderer.setRenderTarget(this.prep);
    renderer.clear(true, false, false);
    this.quad.render(renderer);

    let input: THREE.Texture = this.prep.texture;
    for (let i = 0; i < this.mips; i++) {
      const rt = this.horiz[i];
      const step = this.blurMat.uniforms.uStep.value as THREE.Vector2;
      this.quad.material = this.blurMat;

      this.blurMat.uniforms.tSrc.value = input;
      step.set(1 / rt.width, 0);
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
      this.quad.render(renderer);

      this.blurMat.uniforms.tSrc.value = rt.texture;
      step.set(0, 1 / rt.height);
      renderer.setRenderTarget(this.vert[i]);
      renderer.clear(true, false, false);
      this.quad.render(renderer);

      input = this.vert[i].texture;
    }

    this.compMat.uniforms.uStrength.value = this.strength;
    this.compMat.uniforms.uRadius.value = this.radius;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  override setSize(width: number, height: number): void {
    let w = Math.max(1, Math.round(width / this.div));
    let h = Math.max(1, Math.round(height / this.div));
    this.src.setSize(w, h);
    this.prep.setSize(w, h);
    for (let i = 0; i < this.mips; i++) {
      this.horiz[i].setSize(w, h);
      this.vert[i].setSize(w, h);
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
  }

  override dispose(): void {
    this.src.dispose();
    this.prep.dispose();
    for (let i = 0; i < this.mips; i++) {
      this.horiz[i].dispose();
      this.vert[i].dispose();
    }
    this.prepMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ambient occlusion
// ---------------------------------------------------------------------------

/**
 * GTAO with an opaque-only G-buffer, used as a WIDE CONTACT term.
 *
 * WHAT THIS PASS IS FOR, because it was aimed at the wrong target for two
 * rounds. Screen-space AO cannot find a voxel block seam in this world, and no
 * amount of radius or intensity tuning changes that: the chunk mesher merges
 * coplanar faces, so where two terrain cubes meet there is no depth
 * discontinuity and no normal discontinuity for the pass to see. Asking for it
 * produced exactly what ?aoview=1 showed — a near-uniform white AO buffer.
 * Crevice darkening is now baked per vertex by the mesher (the classic voxel
 * corner-AO table in world/chunk.ts), which is where it belongs.
 *
 * What is left is the thing screen-space AO is actually good at and baked vertex
 * AO cannot do at all: contact between SEPARATE objects. A pal standing on
 * grass, a rock sitting in a meadow, a shop's stilts meeting sand — none of that
 * is in any mesh's vertex data. Hence a world-space radius of ~1.5 units (a pal
 * is ~1.5 units tall, a terrain cube 1.0) and a gentle exponent, which reads as
 * a soft darkening ring where things touch the ground rather than as a grey film.
 *
 * A world-space radius is also why the two-scales problem from round 2 is gone:
 * it no longer matters that a pal's own voxels are 0.08 units while a terrain
 * cube is 1.0, because we are no longer trying to shade either one's creases.
 *
 * GTAOPass rebuilds depth and normals by re-rendering the scene with a
 * MeshNormalMaterial override, and stock it draws *everything*, including
 * transparent surfaces that never wrote depth in the beauty pass. Two things go
 * wrong with that here:
 *
 *  1. The lake turned solid black. The water chunks are a bare BufferGeometry
 *     with position + a depth attribute and no `normal`, because their own
 *     shader derives the normal analytically from the ripple field. Under the
 *     override material the missing attribute reads as (0,0,0), normalize()
 *     gives NaN, and GTAO reads that as "fully occluded".
 *  2. Every additive VFX sprite in front of the camera would stamp its quad into
 *     the depth buffer and carve a hole of fake occlusion behind it.
 *
 * Both disappear once the AO G-buffer contains exactly what the opaque pass
 * contains. overrideVisibility/restoreVisibility are the pass's own hook for
 * this — the base call caches every object's `visible` flag first, so anything
 * hidden afterwards is restored for free.
 */
class OpaqueGTAOPass extends GTAOPass {
  /**
   * Resolution divisor for the whole AO chain (G-buffer re-render, the AO
   * samples and the denoise). Set from ?aoq=.
   *
   * 2 (half res) is the default and it is a quality choice as much as a cost
   * one: GTAO's per-pixel noise rotation leaves a fine grain that is clearly
   * visible as mottling on a flat cube face at full res, and the bilinear
   * upsample from half res smooths it away for free. On art made of 1-unit cubes
   * there is no AO detail finer than a couple of pixels to lose. It also keeps
   * the emissive bloom source (which borrows this pass's depth texture) at the
   * half res it wants anyway.
   */
  divisor = 2;

  override setSize(width: number, height: number): void {
    const d = this.divisor;
    super.setSize(Math.max(1, Math.round(width / d)), Math.max(1, Math.round(height / d)));
  }

  override overrideVisibility(): void {
    super.overrideVisibility();
    this.scene.traverse((obj) => {
      if (obj.visible === false) return;
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const m = Array.isArray(mat) ? mat[0] : mat;
      if (m && (m.transparent || (obj as THREE.Sprite).isSprite)) obj.visible = false;
    });
  }
}

// ---------------------------------------------------------------------------
// Output: highlight rolloff -> ACES -> sRGB -> filmic grade
// ---------------------------------------------------------------------------

/**
 * The single HDR -> display step, plus the grade, in one fullscreen pass.
 *
 * It replaces three's OutputPass and the separate grade ShaderPass. Merging
 * them is not only about saving a round trip: the highlight rolloff has to sit
 * immediately before the tone curve to do its job, and having the whole chain
 * of "compress, tone map, encode, grade" visible in one shader is the only way
 * to reason about which space each number lives in.
 *
 * Everything up to acesFilmic() is SCENE-REFERRED LINEAR; everything after it is
 * display-referred 0..1 sRGB. The grade is restrained on purpose: Cube World is
 * bright, clean and saturated, not a teal-and-orange blockbuster.
 */
const TonemapGradeShader = {
  name: 'CubePalsOutput',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Mirrors renderer.toneMappingExposure; PostFX.render() keeps it in sync. */
    uExposure: { value: 1.02 },
    /**
     * Highlight rolloff knee, in linear radiance. THE FIX FOR WHITE EMISSIVE
     * PLATEAUX. ACES desaturates as it saturates: emberfox's flame core renders
     * at ~4 linear, and ACES turns any bright saturated colour that hot into flat
     * #ffffff, so the flame lost its shape and its hue entirely — captured as a
     * white rectangle where a fire should be. Same for the sun disk.
     *
     * The knee sits ABOVE the brightest sky value (the dome tops out near 1.0
     * linear, its aureole aside) so nothing about the sky, clouds, water or
     * ground changes by a single code value. Only genuinely blown emissives are
     * touched, and they are compressed by a scalar taken from the MAX channel so
     * the r:g:b ratio — the hue — survives untouched however hot the source is.
     */
    uRollKnee: { value: 1.55 },
    /**
     * Headroom above the knee. The compressor asymptotes at knee + headroom, so
     * 1.55 + 1.05 = 2.6 linear is the hardest value that can ever reach the tone
     * curve. ACES(2.6) is ~0.90 with chroma intact, i.e. a bright, still clearly
     * orange flame core instead of a white hole.
     */
    uRollHead: { value: 1.05 },
    /** 0 = tone map and encode only (?grade=0). */
    uGrade: { value: 1 },
    /**
     * 1 = show the incoming buffer's raw values, no rolloff, no tone curve, no
     * encode, no grade. Only ?aoview=1 sets this, and it is not cosmetic: the AO
     * debug view used to be pushed through ACES and the grade like a picture, so a
     * genuine AO of 0.70 displayed as #c8c8c8 and the buffer looked blank white
     * even when the pass was working. That misread cost a whole review round.
     */
    uDebug: { value: 0 },
    // 0.13. The S-curve's lower half is a black-crusher, and between it and the
    // baked corner AO the shadowed treeline was collapsing into one unreadable
    // mass. Most of the midtone separation the curve was buying is now bought by
    // the mesher's corner AO instead, for free.
    uContrast: { value: 0.13 },
    // Saturation, as a pair: darks get more than lights. A single global figure
    // cannot win here — 1.05 everywhere left every face the sun misses reading as
    // grey cardboard (a dirt wall measured #1e211e, i.e. no hue at all), while
    // raising it globally to 1.18 tipped sunlit grass into neon. Shading toward
    // the shadows is free: that is exactly where tone mapping and the ambient fill
    // have eaten the chroma.
    uSatDark: { value: 1.12 },
    uSatLit: { value: 1.04 },
    // 0.042. The cheapest part of "shadows must read cooler, never hue-rotated":
    // it is a gain, so it cannot shift a neutral, but it pulls the shaded midtones
    // toward blue and the sunlit ones toward amber. Above ~0.06 it starts to look
    // like a teal-and-orange film LUT, which is the opposite of Cube World.
    uSplit: { value: 0.042 },
    // Shadow floor. 0.17, up from 0.10. Measured on a gameplay frame this takes
    // grass in cast shadow from 17% of its sunlit luminance to ~30%, which is
    // where Cube World's shadows sit — they are a darker, cooler version of the
    // surface, not a hole in the picture.
    uShadowLift: { value: 0.17 },
    // How much of the lift follows the pixel's OWN hue rather than the cool tint,
    // BEFORE the saturation weighting in the shader. Two opposite failures have to
    // be fixed by one term, which is why it is weighted rather than fixed:
    //   - a shaded DIRT wall (low saturation, brown) went to neutral grey under a
    //     purely cool achromatic lift — measured, 25% saturation down to 4%;
    //   - shaded GRASS (very high saturation, green with no red left in it at all,
    //     because the fill is blue and the albedo is green) goes MORE saturated
    //     under a hue-following lift, which is the "near-black olive green" read.
    // So the shader scales this by (1 - saturation): near-neutral pixels are lifted
    // along their own hue, already-saturated ones get the neutral cool lift that
    // opens them up instead of deepening them.
    uLiftHue: { value: 0.85 },
    // 0.07, with its falloff pushed outward (see the shader). At 0.16 with
    // crushed corners the frame was losing real detail — the treeline in the
    // top-right of a gameplay shot went to a single value.
    uVignette: { value: 0.07 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uRollKnee;
    uniform float uRollHead;
    uniform float uGrade;
    uniform float uDebug;
    uniform float uContrast;
    uniform float uSatDark;
    uniform float uSatLit;
    uniform float uSplit;
    uniform float uShadowLift;
    uniform float uLiftHue;
    uniform float uVignette;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    // three's ACESFilmicToneMapping, transcribed so the exposure can come from
    // our own uniform. Matching it exactly matters: every sky, fog and terrain
    // colour in this project was solved backwards through THIS curve, and the
    // ?post=0 fallback still uses the renderer's built-in copy of it.
    //
    // THE cp PREFIX IS LOAD-BEARING. three injects tonemapping_pars_fragment —
    // which defines RRTAndODTFit and ACESFilmicToneMapping — into any material
    // with toneMapped left on that renders to the DEFAULT FRAMEBUFFER. This pass
    // is normally followed by SMAA and so draws into a render target, where the
    // chunk is omitted; with ?aa=0 it becomes the last pass, the chunk appears,
    // and unprefixed names collided with "function already has a body". The
    // material also sets toneMapped = false (see the constructor) so the chunk is
    // never injected and the curve can never be applied twice.
    vec3 cpRRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 cpAcesFilmic(vec3 color) {
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777)
      );
      const mat3 ACESOutputMat = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602)
      );
      color *= uExposure / 0.6;
      color = ACESInputMat * color;
      color = cpRRTAndODTFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      if (uDebug > 0.5) {
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        return;
      }

      // 0. Hue-preserving highlight rolloff, in scene-referred linear. The
      //    scalar comes from the max channel so the ratio between channels — the
      //    hue — is untouched; a per-channel compressor would pull r toward g and
      //    b and re-create the whitening it exists to prevent.
      float peak = max(max(c.r, c.g), c.b);
      if (uRollKnee > 0.0 && peak > uRollKnee) {
        float over = peak - uRollKnee;
        float rolled = uRollKnee + uRollHead * over / (uRollHead + over);
        c *= rolled / peak;
      }

      // 1. The one HDR -> display step.
      c = cpAcesFilmic(c);

      // 2. sRGB encode. Same piecewise curve three's colorspace_fragment uses.
      c = mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055,
              step(vec3(0.0031308), c));
      c = clamp(c, 0.0, 1.0);

      vec3 graded = c;

      // 3. Contrast S-curve. smoothstep is a Hermite S with zero slope at both
      //    ends, so mixing toward it firms up midtone separation and can never
      //    clip. A partial mix keeps the shadows open the way Cube World's
      //    screenshots are — a full curve crushes the tree undersides to mud.
      graded = mix(graded, smoothstep(vec3(0.0), vec3(1.0), graded), uContrast);

      float l = dot(graded, LUMA);

      // 4. Saturation, weighted toward the shadows (see uSatDark).
      float sat = mix(uSatDark, uSatLit, smoothstep(0.06, 0.42, l));
      graded = mix(vec3(l), graded, sat);

      // 5. Warm/cool split so sunlight reads warm and shade reads cool. Applied
      //    multiplicatively (a gain, not an offset) so neutral whites stay white
      //    and only the tinted midtones move.
      vec3 warm = vec3(1.0 + uSplit, 1.0 + uSplit * 0.25, 1.0 - uSplit * 0.80);
      vec3 cool = vec3(1.0 - uSplit * 0.85, 1.0 - uSplit * 0.10, 1.0 + uSplit * 0.95);
      graded *= mix(cool, warm, smoothstep(0.24, 0.82, l));

      // 6. Shadow floor. The falloff is QUARTIC: (1-l)^4 is 0.81 of the lift at
      //    l=0.05, 0.24 at l=0.3 and 0.06 at l=0.5, so it is a genuine floor under
      //    the darkest values and has effectively vanished by the midtones. A cubic
      //    at the strength needed here visibly lifted lit grass; a thresholded
      //    smoothstep puts a hard edge into the gradient where it crosses over.
      //
      //    The TINT is saturation-weighted — see uLiftHue for the two failures it
      //    has to fix at once.
      float dark = 1.0 - l;
      dark *= dark;
      dark *= dark;
      float mx = max(max(graded.r, graded.g), graded.b);
      float mn = min(min(graded.r, graded.g), graded.b);
      float chromaAmt = 1.0 - mn / max(mx, 0.02);
      vec3 hueDir = graded / max(l, 0.05);
      vec3 tint = mix(vec3(0.86, 0.97, 1.20), hueDir, uLiftHue * (1.0 - chromaAmt));
      graded += uShadowLift * dark * tint;

      // 7. Vignette. Elliptical in screen space (deliberately not aspect
      //    corrected — it should hug the frame, not describe a circle). The
      //    falloff starts at 0.16 (roughly two thirds of the way to the corner)
      //    so it shapes the frame instead of eating the corners.
      vec2 d = vUv - 0.5;
      graded *= 1.0 - uVignette * smoothstep(0.16, 0.62, dot(d, d));

      c = mix(c, graded, uGrade);

      // 8. Ordered-ish dither at 1/255. The sky is a long smooth gradient and
      //    8-bit output bands it visibly; a static hash (not animated, so stills
      //    stay reproducible) breaks the steps up below the noise floor.
      float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) / 255.0;

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------
// A no-op pass that samples renderer.info between the scene and the post chain
// ---------------------------------------------------------------------------

class StatsProbePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = true;
  }

  override render(renderer: THREE.WebGLRenderer): void {
    // Engine clears renderer.info once per frame with autoReset off, so at this
    // point in the chain the counters hold exactly the scene render.
    postStats.sceneCalls = renderer.info.render.calls;
    postStats.sceneTris = renderer.info.render.triangles;
  }
}

// ---------------------------------------------------------------------------
// PostFX
// ---------------------------------------------------------------------------

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: EmissiveBloomPass | null;
  readonly ao: GTAOPass | null;
  readonly output: ShaderPass;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    opts: {
      ao: number; aoRadius: number; aoScale: number; aoThickness: number;
      aoScreenSpace: boolean; aoDiv: number; aoView: boolean;
      bloom: number; sceneBloom: number; sceneBloomThreshold: number;
      roll: number; grade: boolean; aa: boolean;
    },
  ) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new StatsProbePass());

    if (opts.ao > 0) {
      // Constructed at the full drawing-buffer size; setSize() halves it, and the
      // composer calls setSize() on every pass as it is added.
      const ao = new OpaqueGTAOPass(scene, camera, size.x, size.y);
      ao.divisor = opts.aoDiv;
      // A WORLD-SPACE radius, back from the screen-space one two rounds of tuning
      // went down. Screen-space was the right answer to the wrong question: it
      // makes the occlusion a fixed size on screen, which is what you want when
      // the AO has to resolve creases at two very different object scales. This
      // pass no longer resolves creases at all (see OpaqueGTAOPass), it answers
      // "how close is the nearest other surface", and that question has a
      // world-space answer: about one and a half terrain cubes.
      //
      // THE UNIT IS A TRAP IN THE OTHER MODE. With screenSpaceRadius on,
      // GTAOShader reads `radius` as HUNDREDS of AO-buffer pixels, which is how
      // an innocent-looking 1.3 became a 260-screen-pixel reach whose every
      // sample landed on geometry a metre away and got rejected by `thickness` —
      // the blank white ?aoview=1 buffer. Off, `radius` is plain world units.
      //
      // `scale` is an exponent on the occlusion (ao = pow(ao, scale)). 1.1 is
      // barely above linear on purpose: a steep exponent is what a crevice term
      // wants, and this is a broad contact term, where the same steepness turns
      // every silhouette into a hard black outline.
      //
      // 32 samples, not three's default 16: 16 means 3 directions x 6 steps, and
      // that undersampling printed visible salt-and-pepper along every silhouette
      // that the denoise could not clean up (it cannot average across a depth
      // discontinuity, which is exactly where the noise sits). At half res that
      // is the fill cost of 8 full-res samples.
      ao.updateGtaoMaterial({
        radius: opts.aoRadius,
        distanceExponent: 1.0,
        thickness: opts.aoThickness,
        distanceFallOff: 0.6,
        scale: opts.aoScale,
        samples: 32,
        screenSpaceRadius: opts.aoScreenSpace,
      });
      // Denoise radius is in AO-buffer pixels, which are half-size here, so 4
      // spans 8 pixels of the final image. A wide contact term is smooth by
      // nature and wants more smoothing than the old crevice term did (3), but
      // three's default of 8 (16 effective) smeared occlusion a visible distance
      // off silhouettes — worst on a pal against the sky.
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 16 });
      ao.blendIntensity = opts.ao;
      // ?aoview=1 renders the denoised AO buffer straight to screen. The only
      // practical way to tell "the AO is noisy" from "the art is noisy".
      if (opts.aoView) ao.output = GTAOPass.OUTPUT.Denoise;
      this.composer.addPass(ao);
      this.ao = ao;
    } else {
      this.ao = null;
    }

    if (opts.bloom > 0) {
      // radius 0.38, not the 0.72 an Unreal preset uses: a wide radius spends the
      // energy on a big soft halo, which on a solid block of emissive voxels is
      // exactly the "blob that ate the pal" failure. Biasing toward the tight mips
      // makes a shop crystal read as a bright gem you could reach out and touch
      // and still leaves the emberfox's tail a fox tail. (It was 0.50, which is the
      // one value where the weighting function collapses to uniform — see w() in
      // the composite shader — so the bias was silently doing nothing.)
      // this.ao is created above and runs earlier in the chain, so by the time the
      // bloom pass runs its depth texture already holds this frame's opaque scene.
      const bloom = new EmissiveBloomPass(
        scene, camera, size.x, size.y, opts.bloom, 0.38,
        this.ao?.depthTexture ?? null, opts.sceneBloomThreshold, opts.sceneBloom,
        this.ao ? opts.aoDiv : 2,
      );
      this.composer.addPass(bloom);
      this.bloom = bloom;
    } else {
      this.bloom = null;
    }

    // HDR -> display, plus the grade. Must come after everything that wants
    // linear values, and before SMAA, which needs display-referred colour.
    const output = new ShaderPass(TonemapGradeShader);
    // See cpAcesFilmic: this shader does the tone curve itself, so three must not
    // inject its own (which it does for any toneMapped material drawing to the
    // default framebuffer — i.e. whenever this pass is last, as with ?aa=0).
    output.material.toneMapped = false;
    output.material.uniforms.uRollKnee.value = opts.roll;
    output.material.uniforms.uGrade.value = opts.grade ? 1 : 0;
    output.material.uniforms.uDebug.value = opts.aoView ? 1 : 0;
    this.composer.addPass(output);
    this.output = output;

    if (opts.aa) {
      this.composer.addPass(new SMAAPass(size.x, size.y));
    }

    postStats.passes = this.composer.passes.length;
  }

  render(): void {
    // Exposure is read live rather than captured at construction so the ?post=0
    // fallback (which uses the renderer's own ACES) and the composer path can
    // never drift apart.
    this.output.material.uniforms.uExposure.value = this.renderer.toneMappingExposure;
    this.composer.render();
  }

  /**
   * Resize every render target in the chain. Both arguments are CSS pixels;
   * EffectComposer multiplies by its own pixel ratio, which has to be refreshed
   * first or a DPR change silently keeps rendering at the old backing size.
   */
  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  dispose(): void {
    // EffectComposer.dispose() only releases its own two buffers, so the passes
    // (which own most of the render targets here) have to be walked explicitly.
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
  }
}

/** Read the post-processing URL overrides once. */
export function readPostOptions(search: string): {
  enabled: boolean;
  ao: number;
  aoRadius: number;
  aoScale: number;
  aoThickness: number;
  aoScreenSpace: boolean;
  aoDiv: number;
  aoView: boolean;
  bloom: number;
  sceneBloom: number;
  sceneBloomThreshold: number;
  roll: number;
  grade: boolean;
  aa: boolean;
} {
  const p = new URLSearchParams(search);
  const num = (k: string, d: number): number => {
    const v = p.get(k);
    if (v === null) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled: p.get('post') !== '0',
    // 1.35. GTAOPass's blend lerps white toward the AO buffer by this factor, so
    // above 1.0 it darkens harder than the geometry says. Swept at 1.0/1.2/1.35/
    // 1.6 on the hero+pal framing: 1.0 grounded the characters but you had to look
    // for it, 1.6 started dimming whole pal bodies (the emberfox's belly went
    // grubby). 1.35 plants a foot on the ground and stops there.
    ao: num('ao', 1.35),
    // World units (see the pass). 1.8 — a shade over a pal's height and nearly
    // twice a terrain cube, i.e. the reach over which a foot, a rock's base or a
    // shop's stilt darkens the ground it stands on. 2.5+ wraps a whole creature
    // and reads as dirt rather than as contact.
    aoRadius: num('aor', 1.8),
    // 1.1 (exponent on the occlusion). Nearly linear: see the pass for why a
    // steep exponent belongs to a crevice term and ruins a contact one.
    aoScale: num('aos', 1.1),
    // World units. GTAOShader rejects a sample whose view-space depth delta
    // exceeds this, so it is the "how thick do I assume an occluder is" knob.
    // It is also the range over which a FOREGROUND object may darken the surface
    // behind it, i.e. the halo knob: at 1.6 with the old wide screen-space radius
    // a pal standing a metre in front of a terrace wall printed a 30-pixel dark
    // aura all round its silhouette. 1.0 is matched to the contact radius, so the
    // worst case is a soft shadow a single cube deep behind a silhouette — which
    // is what a contact term is supposed to look like.
    aoThickness: num('aot', 1.3),
    // Off by default: world-space radius. ?aoss=1 switches back to the
    // screen-space interpretation of aor (hundreds of AO-buffer pixels).
    aoScreenSpace: p.get('aoss') === '1',
    // Half res. A 1.5-unit contact blob has no detail finer than a couple of
    // pixels, the bilinear upsample smooths GTAO's per-pixel noise rotation away
    // for free, and it quarters the fill for both this chain and the bloom source
    // that borrows this pass's depth texture. Full res (?aoq=1) only mattered when
    // the pass was chasing 1-unit crevices, which the mesher now bakes.
    aoDiv: Math.max(1, num('aoq', 2)),
    // 0.40, not an Unreal-ish 0.85: every glow here is a solid block of emissive
    // voxels rather than a point source, and at 0.85 the emberfox's flame tail
    // became a white blob that swallowed the pal's whole silhouette. Paired with
    // the tight bloom radius below, 0.40 buys back the punch a shop crystal needs
    // without the blob coming back.
    bloom: num('bloom', 0.40),
    sceneBloom: num('sbloom', 1.2),
    sceneBloomThreshold: num('sbt', 0.80),
    // Highlight rolloff knee in linear radiance; see TonemapGradeShader. 0
    // disables it, which is the fastest way to see the white-plateau failure it
    // exists to fix.
    roll: num('roll', 1.55),
    grade: p.get('grade') !== '0',
    aa: p.get('aa') !== '0',
    aoView: p.get('aoview') === '1',
  };
}
