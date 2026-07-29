import * as THREE from 'three';

/**
 * Rendering engine: renderer, scene, camera, sky, sun/ambient lighting, fog.
 * Visual grading lives here so the critic loop has one place to tune.
 */

// Gradient sky dome: zenith blue -> pale horizon with a subtle warm band.
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
void main() {
  float h = normalize(vDir).y;
  vec3 zenith = vec3(0.373, 0.659, 0.910);   // 0x5fa8e8
  vec3 horizon = vec3(0.812, 0.910, 0.957);  // 0xcfe8f4
  vec3 col = mix(horizon, zenith, smoothstep(-0.02, 0.42, h));
  // subtle warm tint hugging the horizon line
  float warm = (1.0 - smoothstep(0.0, 0.18, abs(h))) * 0.14;
  col = mix(col, vec3(1.0, 0.925, 0.82), warm);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private clock = new THREE.Clock();
  private minFrameMs = 0;
  private lastFrameMs = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Clear color matches the dome's horizon so any sliver of background blends.
    this.scene.background = new THREE.Color(0xcfe8f4);
    // Aerial perspective: the far plane is 600, so a fog end of 420 meant
    // almost nothing in frame ever received atmospheric desaturation and
    // distant mountains stayed as saturated as foreground grass. Ending at
    // 250 puts the far ridgelines well inside the gradient so they read as
    // pale blue depth cues, while a start of 95 keeps the playable bubble
    // around the hero perfectly crisp. The tint is a touch deeper than the
    // sky horizon (0xcfe8f4) so far ridges still separate from the backdrop.
    this.scene.fog = new THREE.Fog(0xc2dcf2, 95, 250);

    // One-draw-call inverted sphere; follows the camera each frame (render()).
    this.skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    );
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 600,
    );
    this.camera.position.set(0, 12, 18);

    this.sun = new THREE.DirectionalLight(0xfff2d9, 2.55);
    // Sun sits above the raised cloud deck (90-115) so clouds still cast.
    this.sun.position.set(60, 160, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 380;
    const s = 90;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Fill is kept well below the sun so a creature still reads ~30% darker on
    // its shadow side than its lit side (form shading); the ground bounce is
    // deep enough that the dark side goes warm-green, not black.
    this.ambient = new THREE.HemisphereLight(0xcfe8ff, 0x6b7f52, 0.52);
    this.scene.add(this.ambient);

    // Responsive: plain resizes, orientation flips, and the mobile URL bar
    // collapsing (which fires on visualViewport, not window).
    const resize = (): void => this.onResize(container);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => {
      // iOS reports stale metrics during the flip; settle first.
      setTimeout(resize, 120);
    });
    window.visualViewport?.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize).observe(container);
    }
  }

  /** Keep the shadow frustum centered on the action */
  updateSunFocus(focus: THREE.Vector3): void {
    this.sun.position.set(focus.x + 60, 160, focus.z + 40);
    this.sun.target.position.copy(focus);
  }

  private onResize(container: HTMLElement): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    // Cap the backing-store scale on small screens: a 3x DPR phone rendering a
    // shadow-mapped scene at native resolution tanks the frame rate for no
    // visible gain at this art style's chunkiness.
    const dprCap = Math.min(w, h) < 700 ? 1.6 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
    // Narrow (portrait phone) viewports need a wider FOV or the character fills
    // the frame; widen as aspect drops below 4:3.
    const aspect = w / h;
    this.camera.fov = aspect < 1.33 ? Math.min(72, 55 / Math.max(0.62, aspect / 1.33)) : 55;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /**
   * Frame-rate cap. 0 = uncapped. Agent capture runs use 30 so software-GL
   * rendering doesn't burn time on frames nobody looks at.
   */
  setFpsCap(fps: number): void {
    this.minFrameMs = fps > 0 ? 1000 / fps - 1 : 0; // -1ms so rAF jitter doesn't drop a frame
  }

  /**
   * Call at the top of the frame callback. Returns false when the cap says
   * this frame should be skipped — skip tick/update/render and return.
   * Because tick() reads the clock delta, a skipped frame simply rolls its
   * elapsed time into the next one, so simulation speed is unaffected.
   */
  beginFrame(): boolean {
    if (this.minFrameMs <= 0) return true;
    const now = performance.now();
    if (now - this.lastFrameMs < this.minFrameMs) return false;
    this.lastFrameMs = now;
    return true;
  }

  /** Returns dt in seconds, clamped */
  tick(): number {
    return Math.min(this.clock.getDelta(), 0.05);
  }

  render(): void {
    // Sky dome tracks the camera so the horizon never slides (no allocs).
    this.skyDome.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
