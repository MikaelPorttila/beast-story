import * as THREE from 'three';
import type { BeastAnimCtx, BeastRig, BeastSpecies } from '../core/types';
import { BEAST_CYCLE_SLOTS } from '../core/types';
import { buildHeroRig, setWeaponModel, type HeroRig } from '../player/hero-rig';
import { WEAPON_MODEL_IDS, type WeaponModelId } from '../player/weapons';
import { HeroAnimator, type AnimInput } from '../player/animations';

/**
 * THE LITTLE STAGE AT THE TOP OF THE INVENTORY — the hero and the two beasts
 * standing with him, in 3D, plus the baked portrait each species wears in its
 * grid slot.
 *
 * A SECOND WebGLRenderer, AND THAT IS THE DECISION THE FILE RESTS ON. Three
 * alternatives were considered and all three are worse:
 *
 *   * Render the cast into the MAIN renderer and copy its canvas. One renderer
 *     draws to one canvas, so this means rendering the world, rendering the
 *     cast, copying, and rendering the world again — the world's frame is 67%
 *     of the budget (see the F2 note in AGENTS.md) and this doubles it while a
 *     panel is open.
 *   * Put the cast in the main SCENE, far away, and use a second camera. Same
 *     problem: still one canvas.
 *   * Bake everything to images and show no live preview. That is the feature.
 *
 * A second context costs its own program links, so this is built on FIRST OPEN
 * and kept for the session — the panel is opened many times and the second one
 * must be instant.
 *
 * THE RIGS ARE THIS FILE'S OWN, never the roster's. A `BeastActor`'s rig is in
 * the world scene with the world's shadow layers and the framework's own
 * animator driving it; borrowing one would either move it out of the world or
 * fight over its pose every frame. `species.buildRig()` is cheap enough to call
 * again (the whole roster is ~85 ms at boot for TEN, and this builds at most
 * two plus the hero), and the cache below means each species is built once.
 *
 * NOTHING HERE READS GAME STATE. It is handed two species and animates them
 * idling; what a "primary beast" is stays in main.ts, exactly as it does for the
 * panel this belongs to.
 */

/** The portrait size baked for a grid slot. Square, transparent, cached. */
const ICON = 128;

/**
 * HOW WIDE A SLICE OF THE WORLD THE STAGE SHOWS, and everything about the
 * arrangement falls out of it.
 *
 * The camera is framed on this WIDTH rather than on the subjects' height, which
 * is what lets the three figures line up with the three gear slots underneath
 * them: the slot strip is `repeat(3,1fr)`, so its centres are at thirds of the
 * panel's width, and a beast standing at a third of the stage's width is drawn
 * over its own slot at every window size. Frame on height instead and the
 * figures drift sideways as the dock's aspect changes, which is the version of
 * this that shipped first and looked like a bug in the layout.
 */
const STAGE_W = 6.4;
const HERO_X = 0;
/**
 * A THIRD OF THE FRAME IS WHERE THE SLOT IS; 0.30 is where the beast stands.
 *
 * Exactly on the third puts a wingtip past the edge of the canvas — measured, a
 * Galebird's outer wing reaches about 1.0 world units and the gap from the
 * third to the frame's edge is STAGE_W/6, so it wants a stage 25% wider and a
 * hero 25% smaller to pay for it. The inset is the cheaper half of that trade:
 * a tenth of the way in is not a misalignment anyone can see against a slot
 * that is a third of the panel wide, and it buys 0.28 units of wing.
 */
const BEAST_X = STAGE_W * 0.3;
/** A step BACK as well as out, so a wingspan cannot cut across the hero. */
const BEAST_Z = -0.3;
/** Eye height and aim point. The hero is ~1.7 tall; this looks at his chest. */
const EYE_Y = 1.12;
const LOOK_Y = 0.98;
/** Vertical slice the framing must always contain, however wide the dock is. */
const STAGE_H = 3.0;

/**
 * How the stage hero PRESENTS his weapon — see the write in `tick`.
 *
 * Measured against the animator's own numbers rather than guessed: its rest
 * pose is `swX` 2.62 (slung down the back of the leg) and its overhead chop
 * ends at 1.35, so a value between them is the arc where the weapon is off the
 * body and still in a hand that is hanging naturally. The yaw turns the flat of
 * the blade — and the plane of the bow — toward the camera, which is the whole
 * point of showing it here at all.
 */
const SHOW_X = 0.62;
const SHOW_Y = 0.28;
const SHOW_Z = 0.12;

/** The idle every subject plays. See `beastCtx`. */
const IDLE_SPEED = 0;

/**
 * A per-rig cycle integrator, which is the one thing `BeastAnimCtx` cannot be
 * given as a plain object: `cycle()` is STATE — see the long note on it in
 * core/types.ts — so each subject carries its own phase array or two beasts
 * sharing one ctx would beat in lockstep and then jump when either changed.
 */
class Cycles {
  private phase = new Float32Array(BEAST_CYCLE_SLOTS);
  step(slot: number, freq: number, dt: number): number {
    const i = slot < 0 || slot >= BEAST_CYCLE_SLOTS ? 0 : slot;
    // The framework clamps this for the same reason; restated rather than
    // imported because the framework's copy is private to it.
    this.phase[i] = (this.phase[i] + Math.min(24, freq) * dt) % (Math.PI * 2);
    return this.phase[i];
  }
}

interface Subject {
  /**
   * The species is CARRIED rather than looked up by id: `animate` is a method
   * on it, and a stage subject without one is a rig nothing can pose.
   */
  species: BeastSpecies;
  rig: BeastRig;
  cycles: Cycles;
  t: number;
}

export class InventoryStage {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  private canvas: HTMLCanvasElement | null = null;

  private hero: HeroRig | null = null;
  private heroAnim = new HeroAnimator();
  private heroTime = 0;

  /** One built rig per species, kept for the session. */
  private rigs = new Map<string, Subject>();
  /** Which of them are on stage right now, by species id. */
  private onStage: (Subject | null)[] = [null, null];

  /** Baked portraits, by species id. */
  private icons = new Map<string, string>();
  /** Species queued for baking, one per frame — see `bakeStep`. */
  private bakeQueue: BeastSpecies[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private iconCamera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);

  private raf = 0;
  private lastT = 0;

  /** Called when a portrait finishes baking, so the panel can patch one slot. */
  onIcon: ((speciesId: string, url: string) => void) | null = null;

  /**
   * Attach to a container. Idempotent — reopening the panel re-parents the same
   * canvas rather than building a second context.
   */
  mount(host: HTMLElement): void {
    if (!this.renderer) this.build();
    if (this.canvas) host.appendChild(this.canvas);
    this.resize();
  }

  private build(): void {
    const canvas = document.createElement('canvas');
    canvas.className = 'stage-gl';
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas, alpha: true,
      // The subjects are voxel boxes with hard edges against a dark panel, so
      // the stair-stepping the main game spends an SMAA pass on is very visible
      // here at a tenth of the pixels. MSAA is the cheap answer at this size.
      antialias: true,
      powerPreference: 'low-power',
    });
    // ACES and sRGB out, matching core/engine.ts's output pass closely enough
    // that a beast is the colour here that it is in the world. Not the whole
    // post chain — there is no bloom, no AO and no aerial perspective on a
    // portrait, and none of them would say anything about the model.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer = renderer;

    // The engine's three lights, at the engine's own colours and intensities
    // (core/engine.ts) — key, anti-sun bounce fill, hemisphere ambient. Copied
    // rather than shared because a `Light` belongs to one scene graph, and the
    // numbers are what make a beast recognisable rather than a different
    // material in a different room.
    const sun = new THREE.DirectionalLight(0xffebbe, 3.05);
    sun.position.set(-2.4, 4.2, 3.1);
    const bounce = new THREE.DirectionalLight(0xd7cfa6, 0.38);
    bounce.position.set(2.4, -1.1, -2.6);
    this.scene.add(sun, bounce, new THREE.HemisphereLight(0xb4d6fb, 0x8fa4bd, 0.55));

    this.hero = buildHeroRig();
    this.hero.root.position.set(HERO_X, 0, 0);
    // Facing the camera, which is the whole point of a paper-doll: the world
    // shows you his back all day.
    this.hero.root.rotation.y = 0;
    this.scene.add(this.hero.root);
  }

  /**
   * Who is standing beside the hero. Either may be null.
   *
   * WORKED OUT AS A SET, NOT SLOT BY SLOT, and that is a bug fix rather than a
   * tidy-up. The slot-by-slot version removed the previous occupant of each
   * slot before filling it — which is correct until the two beasts SWAP, the
   * commonest thing this method is ever asked to do. Sending the support beast
   * to the front put its rig into slot 0, and then slot 1's turn removed "the
   * thing that used to be in slot 1" from the scene: the same rig, one line
   * later, so one of the two beasts simply vanished from the stage and stayed
   * gone until something else moved it.
   *
   * So: decide the whole cast, remove only what is no longer wanted, then place
   * what is. `scene.add` on an object already in the scene is a no-op, so the
   * survivor of a swap is never touched.
   *
   * ONE RIG CANNOT STAND IN TWO PLACES, which is the second half of the same
   * report. A `THREE.Object3D` has one parent and one transform, so a cast with
   * the same species in both slots would put one rig at two marks and draw it
   * at whichever was written last. The engine's own rule forbids it
   * (`cycleBeast` and the panel's actions both refuse to lead and support the
   * same beast), but a stage that renders whatever it is handed must not depend
   * on a caller's invariant to avoid drawing a hole.
   */
  setCast(primary: BeastSpecies | null, support: BeastSpecies | null): void {
    if (!this.renderer) this.build();
    const want: (Subject | null)[] = [
      primary ? this.subject(primary) : null,
      support ? this.subject(support) : null,
    ];
    if (want[0] && want[0] === want[1]) want[1] = null;
    for (const prev of this.onStage) {
      if (prev && !want.includes(prev)) this.scene.remove(prev.rig.root);
    }
    this.onStage = want;
    want.forEach((s, i) => {
      if (!s) return;
      const side = i === 0 ? -1 : 1;
      s.rig.root.position.set(BEAST_X * side, 0, BEAST_Z);
      // Turned a few degrees INWARD, toward the hero. Square-on they read as
      // two more items in a row; angled, the three of them read as a party.
      s.rig.root.rotation.y = -side * 0.34;
      this.scene.add(s.rig.root);
    });
  }

  /**
   * Put the equipped weapon in the stage hero's hand.
   *
   * Takes the raw `ItemDef.model` string and guards it, for the reason that
   * field is a string at all: core/ may not import player/, so the union is
   * checked here rather than carried through the item catalogue.
   */
  setHeroWeapon(model: string | null | undefined): void {
    if (!this.renderer) this.build();
    const id = model && (WEAPON_MODEL_IDS as readonly string[]).includes(model)
      ? model as WeaponModelId
      : null;
    if (this.hero) setWeaponModel(this.hero, id);
  }

  /**
   * Who is on the stage AND still in the scene, by species id.
   *
   * Both halves, which is the point: `onStage` alone is what the panel asked
   * for, and the bug this guards against was a rig that had been asked for and
   * then removed from the scene one line later, so the two disagreed and only
   * the scene was on screen. See `setCast`.
   */
  castIds(): (string | null)[] {
    return this.onStage.map((s) => (s && s.rig.root.parent === this.scene ? s.species.id : null));
  }

  /** Build (or find) a species' rig. One per species, kept for the session. */
  private subject(sp: BeastSpecies): Subject {
    const found = this.rigs.get(sp.id);
    if (found) return found;
    const made: Subject = { species: sp, rig: sp.buildRig(), cycles: new Cycles(), t: 0 };
    this.rigs.set(sp.id, made);
    return made;
  }

  /**
   * The portrait for a species' grid slot, or null while it is still queued.
   *
   * Baking is ONE PER FRAME (see `bakeStep`) rather than all ten on the first
   * open: ten rig builds plus ten renders in one task is a visible hitch on the
   * frame the panel appears, which is the frame a player is looking hardest at.
   * A slot with no portrait yet draws its element-coloured lozenge and is
   * patched in place when `onIcon` fires, so nothing waits for anything.
   */
  iconFor(sp: BeastSpecies): string | null {
    const have = this.icons.get(sp.id);
    if (have) return have;
    if (!this.bakeQueue.some((q) => q.id === sp.id)) this.bakeQueue.push(sp);
    return null;
  }

  private bakeStep(): void {
    const sp = this.bakeQueue.shift();
    const renderer = this.renderer;
    if (!sp || !renderer) return;
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(ICON, ICON, {
        colorSpace: THREE.SRGBColorSpace,
        // MSAA on the target too, for the reason `antialias` is on above: a
        // 128px portrait of a voxel model is nearly all edge.
        samples: 4,
      });
    }
    const subject = this.subject(sp);
    const root = subject.rig.root;
    // Staged ALONE and off the live cast's marks, then put back exactly as it
    // was — a species can be both in the bake queue and standing on the stage,
    // and a portrait must not move the beast the player is looking at.
    const parent = root.parent;
    const px = root.position.x, py = root.position.y, pz = root.position.z;
    const ry = root.rotation.y;
    root.position.set(0, 0, 0);
    // Three-quarter view: square-on hides a snout and a profile hides a face.
    root.rotation.y = 0.62;
    if (parent !== this.scene) this.scene.add(root);
    for (const o of this.onStage) if (o && o.rig.root !== root) o.rig.root.visible = false;
    if (this.hero) this.hero.root.visible = false;

    this.framePortrait(subject.rig.height, subject.rig.radius);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.iconCamera);
    const px4 = new Uint8Array(ICON * ICON * 4);
    renderer.readRenderTargetPixels(this.target, 0, 0, ICON, ICON, px4);
    renderer.setRenderTarget(null);

    for (const o of this.onStage) if (o) o.rig.root.visible = true;
    if (this.hero) this.hero.root.visible = true;
    root.position.set(px, py, pz);
    root.rotation.y = ry;
    if (parent !== this.scene) {
      this.scene.remove(root);
      parent?.add(root);
    }

    const url = toDataUrl(px4);
    this.icons.set(sp.id, url);
    this.onIcon?.(sp.id, url);
  }

  /**
   * Point the ICON camera at one subject, from the front and slightly above.
   *
   * DERIVED FROM THE RIG rather than from a per-species number: `height` and
   * `radius` are already on `BeastRig` because the framework needs them for
   * spacing and collision, so a species added tomorrow frames its own portrait.
   * The 1.35 is headroom — wings, ears and a tail all stick out past the body
   * that radius describes.
   */
  private framePortrait(height: number, radius: number): void {
    const cam = this.iconCamera;
    const reach = Math.max(height, radius * 2) * 1.35;
    cam.aspect = 1;
    cam.position.set(0, height * 0.62, reach / (2 * Math.tan((cam.fov * Math.PI) / 360)));
    cam.lookAt(0, height * 0.48, 0);
    cam.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.raf) return;
    this.lastT = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Re-measure the canvas against its box.
   *
   * The panel is a flex column and this canvas is one of its rows, so its size
   * is not known until layout has run — which is why the panel calls this after
   * every render as well as on `mount`.
   */
  resize(): void {
    const c = this.canvas;
    const r = this.renderer;
    if (!c || !r) return;
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    r.setSize(w, h, false);
    const aspect = w / h;
    const cam = this.camera;
    cam.aspect = aspect;
    // Distance that puts STAGE_W across the frame — and then, on a dock narrow
    // enough that STAGE_W of width is less than STAGE_H of height, the distance
    // that fits the height instead. Whichever is FURTHER away wins, so the
    // guaranteed slice is never smaller than both.
    const tanV = Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(0, EYE_Y, Math.max(
      STAGE_W / 2 / (tanV * aspect),
      STAGE_H / 2 / tanV,
    ));
    cam.lookAt(0, LOOK_Y, 0);
    cam.updateProjectionMatrix();
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0.016;
    this.lastT = now;
    const r = this.renderer;
    if (!r) return;

    // One portrait per frame, ahead of the live render so a bake's camera and
    // render-target juggling can never be what the player sees.
    if (this.bakeQueue.length) this.bakeStep();

    this.heroTime += dt;
    if (this.hero) {
      this.heroAnim.update(this.hero, heroIdle(this.heroTime, dt));
      // HELD OUT, NOT SLUNG — and it has to be written AFTER the animator,
      // which owns `sword.rotation.x/.z` and puts the weapon down the back of
      // the leg at rest (x ~ 2.62). That pose is right in the world, where the
      // weapon must stay out of the way of everything the hero is doing, and
      // wrong on a paper doll, where the weapon is one of the two things the
      // player opened the panel to look at. `armR` is left alone: the arm is
      // the animator's and a hand-written arm would fight its idle sway.
      this.hero.sword.rotation.x = SHOW_X;
      this.hero.sword.rotation.z = SHOW_Z;
      this.hero.sword.rotation.y = SHOW_Y;
    }
    for (const s of this.onStage) {
      if (!s) continue;
      s.t += dt;
      s.rig.root.visible = true;
    }
    this.animateCast(dt);
    r.render(this.scene, this.camera);
  };

  private animateCast(dt: number): void {
    for (const s of this.onStage) {
      if (s) s.species.animate(s.rig, beastCtx(s, dt));
    }
  }

  dispose(): void {
    this.stop();
    this.target?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
  }
}

/**
 * `AnimInput` for a hero doing nothing at all — every flag false, no attack, no
 * movement. Spelled out rather than partial, because `HeroAnimator.update`
 * reads every field and a missing one is `undefined` inside a lerp.
 */
const IDLE_ATTACK = { active: false, combo: 0, t: 0, dur: 0.3 };
function heroIdle(time: number, dt: number): AnimInput {
  return {
    time, dt,
    moveNorm: 0, sprinting: false, onGround: true, swimming: false,
    climbing: false, climbRate: 0, riding: false, velY: 0,
    attack: IDLE_ATTACK, dead: false, deadT: 0, landBump: 0, hurtT: 0,
    // He is posing, not fighting, so neither the punch table nor the bow's
    // draw is ever reached — but the fields are required and a lie here would
    // be a lie in a screenshot. The stage poses the held weapon itself, just
    // above (SHOW_X/Y/Z), which is why a bow on show needs nothing from here.
    unarmed: false,
    bow: false,
  };
}

/** The same, for a beast: standing still and breathing. */
function beastCtx(s: Subject, dt: number): BeastAnimCtx {
  return {
    action: 'idle',
    actionTime: s.t,
    time: s.t,
    moveSpeed: IDLE_SPEED,
    dt,
    cycle: (slot, freq) => s.cycles.step(slot, freq, dt),
  };
}

/**
 * RGBA rows out of a render target, into a PNG data URI.
 *
 * The flip is not optional: WebGL's origin is bottom-left and a canvas's is
 * top-left, so a portrait written straight in comes out upside down — which
 * looks like a broken model rather than like a broken blit, and is the kind of
 * bug that gets fixed in the wrong file.
 */
function toDataUrl(px: Uint8Array): string {
  const c = document.createElement('canvas');
  c.width = ICON;
  c.height = ICON;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(ICON, ICON);
  const row = ICON * 4;
  for (let y = 0; y < ICON; y++) {
    const src = (ICON - 1 - y) * row;
    img.data.set(px.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
