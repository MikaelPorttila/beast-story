import * as THREE from "three";
import type { BeastAnimCtx, BeastRig, BeastSpecies } from "../core/types";
import { BEAST_CYCLE_SLOTS } from "../core/types";
import { buildHeroRig, setWeaponModel, type HeroRig } from "../player/hero-rig";
import { WEAPON_MODEL_IDS, type WeaponModelId } from "../player/weapons";
import { HeroAnimator, type AnimInput } from "../player/animations";

/**
 * A SECOND WebGLRenderer: one renderer draws to one canvas, so the main one
 * cannot also draw the cast. Built on first open, kept for the session. Rigs
 * are this file's own — a `BeastActor`'s would fight the framework's animator.
 */

const ICON = 128;

/** Framed on WIDTH, so the figures stay over the three `1fr` gear slots. */
const STAGE_W = 6.4;
const HERO_X = 0;
/** Inset from the slot's third: dead-on puts a Galebird wingtip off-canvas. */
const BEAST_X = STAGE_W * 0.3;
/** A step BACK as well as out, so a wingspan cannot cut across the hero. */
const BEAST_Z = -0.3;
const EYE_Y = 1.12;
const LOOK_Y = 0.98;
const STAGE_H = 3.0;

/** Show pose, between the animator's rest (swX 2.62) and its chop (1.35). */
const SHOW_X = 0.62;
const SHOW_Y = 0.28;
const SHOW_Z = 0.12;

const IDLE_SPEED = 0;

/** `cycle()` is STATE, so each subject needs its own phase or they beat. */
class Cycles {
  private phase = new Float32Array(BEAST_CYCLE_SLOTS);
  step(slot: number, freq: number, dt: number): number {
    const i = slot < 0 || slot >= BEAST_CYCLE_SLOTS ? 0 : slot;
    // Clamp restated rather than imported: the framework's copy is private.
    this.phase[i] = (this.phase[i] + Math.min(24, freq) * dt) % (Math.PI * 2);
    return this.phase[i];
  }
}

interface Subject {
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

  private rigs = new Map<string, Subject>();
  private onStage: (Subject | null)[] = [null, null];

  private icons = new Map<string, string>();
  private bakeQueue: BeastSpecies[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private iconCamera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);

  private raf = 0;
  private lastT = 0;

  /** Called when a portrait finishes baking, so the panel can patch one slot. */
  onIcon: ((speciesId: string, url: string) => void) | null = null;

  /** Idempotent — reopening re-parents the same canvas, no second context. */
  mount(host: HTMLElement): void {
    if (!this.renderer) {
      this.build();
    }
    if (this.canvas) {
      host.appendChild(this.canvas);
    }
    this.resize();
  }

  private build(): void {
    const canvas = document.createElement("canvas");
    canvas.className = "stage-gl";
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      // Voxel edges at a tenth of the pixels; MSAA is cheap at this size.
      antialias: true,
      powerPreference: "low-power",
    });
    // Matches core/engine.ts's output pass, so a beast is the colour it is in
    // the world. No bloom/AO/aerial — none of them say anything about a model.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer = renderer;

    // The engine's own three lights and numbers (core/engine.ts), copied
    // because a `Light` belongs to one scene graph.
    const sun = new THREE.DirectionalLight(0xffebbe, 3.05);
    sun.position.set(-2.4, 4.2, 3.1);
    const bounce = new THREE.DirectionalLight(0xd7cfa6, 0.38);
    bounce.position.set(2.4, -1.1, -2.6);
    this.scene.add(sun, bounce, new THREE.HemisphereLight(0xb4d6fb, 0x8fa4bd, 0.55));

    this.hero = buildHeroRig();
    this.hero.root.position.set(HERO_X, 0, 0);
    this.hero.root.rotation.y = 0;
    this.scene.add(this.hero.root);
  }

  /**
   * Diffed as a SET, not slot by slot: on a swap, slot-by-slot removal deletes
   * the rig the other slot just placed. One rig cannot stand in two places.
   */
  setCast(primary: BeastSpecies | null, support: BeastSpecies | null): void {
    if (!this.renderer) {
      this.build();
    }
    const want: (Subject | null)[] = [
      primary ? this.subject(primary) : null,
      support ? this.subject(support) : null,
    ];
    if (want[0] && want[0] === want[1]) {
      want[1] = null;
    }
    for (const prev of this.onStage) {
      if (prev && !want.includes(prev)) {
        this.scene.remove(prev.rig.root);
      }
    }
    this.onStage = want;
    want.forEach((s, i) => {
      if (!s) {
        return;
      }
      const side = i === 0 ? -1 : 1;
      s.rig.root.position.set(BEAST_X * side, 0, BEAST_Z);
      s.rig.root.rotation.y = -side * 0.34;
      this.scene.add(s.rig.root);
    });
  }

  /** Guards the raw `ItemDef.model`: core/ may not import player/'s union. */
  setHeroWeapon(model: string | null | undefined): void {
    if (!this.renderer) {
      this.build();
    }
    const id =
      model && (WEAPON_MODEL_IDS as readonly string[]).includes(model)
        ? (model as WeaponModelId)
        : null;
    if (this.hero) {
      setWeaponModel(this.hero, id);
    }
  }

  /** On stage AND still in the scene — the two can disagree, see `setCast`. */
  castIds(): (string | null)[] {
    return this.onStage.map((s) => (s && s.rig.root.parent === this.scene ? s.species.id : null));
  }

  private subject(sp: BeastSpecies): Subject {
    const found = this.rigs.get(sp.id);
    if (found) {
      return found;
    }
    const made: Subject = { species: sp, rig: sp.buildRig(), cycles: new Cycles(), t: 0 };
    this.rigs.set(sp.id, made);
    return made;
  }

  /** Null while queued. Baked one per frame — the roster at once hitches. */
  iconFor(sp: BeastSpecies): string | null {
    const have = this.icons.get(sp.id);
    if (have) {
      return have;
    }
    if (!this.bakeQueue.some((q) => q.id === sp.id)) {
      this.bakeQueue.push(sp);
    }
    return null;
  }

  /** Drains the bake queue with the panel CLOSED (issue #246): the journal's
   *  tips want a portrait without the stage on screen. One bake per frame, the
   *  full tick's own pace; it stands down the moment the live loop runs. */
  private pumpRaf = 0;
  private pump = (): void => {
    this.pumpRaf = 0;
    if (this.raf || this.bakeQueue.length === 0) {
      return;
    }
    this.bakeStep();
    if (this.bakeQueue.length) {
      this.pumpRaf = requestAnimationFrame(this.pump);
    }
  };

  /** `iconFor`, plus the promise that the bake happens even while closed. */
  requestIcon(sp: BeastSpecies): string | null {
    if (!this.renderer) {
      this.build();
    }
    const url = this.iconFor(sp);
    if (url === null && !this.raf && !this.pumpRaf) {
      this.pumpRaf = requestAnimationFrame(this.pump);
    }
    return url;
  }

  private bakeStep(): void {
    const sp = this.bakeQueue.shift();
    const renderer = this.renderer;
    if (!sp || !renderer) {
      return;
    }
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(ICON, ICON, {
        colorSpace: THREE.SRGBColorSpace,
        samples: 4,
      });
    }
    const subject = this.subject(sp);
    const root = subject.rig.root;
    // Staged alone, then restored: a queued species may also be on stage.
    const parent = root.parent;
    const px = root.position.x,
      py = root.position.y,
      pz = root.position.z;
    const ry = root.rotation.y;
    root.position.set(0, 0, 0);
    root.rotation.y = 0.62;
    if (parent !== this.scene) {
      this.scene.add(root);
    }
    for (const o of this.onStage) {
      if (o && o.rig.root !== root) {
        o.rig.root.visible = false;
      }
    }
    if (this.hero) {
      this.hero.root.visible = false;
    }

    this.framePortrait(subject.rig.height, subject.rig.radius);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.iconCamera);
    const px4 = new Uint8Array(ICON * ICON * 4);
    renderer.readRenderTargetPixels(this.target, 0, 0, ICON, ICON, px4);
    renderer.setRenderTarget(null);

    for (const o of this.onStage) {
      if (o) {
        o.rig.root.visible = true;
      }
    }
    if (this.hero) {
      this.hero.root.visible = true;
    }
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

  /** Derived from the rig, so a new species frames itself; 1.35 is headroom. */
  private framePortrait(height: number, radius: number): void {
    const cam = this.iconCamera;
    const reach = Math.max(height, radius * 2) * 1.35;
    cam.aspect = 1;
    cam.position.set(0, height * 0.62, reach / (2 * Math.tan((cam.fov * Math.PI) / 360)));
    cam.lookAt(0, height * 0.48, 0);
    cam.updateProjectionMatrix();
  }

  start(): void {
    if (this.raf) {
      return;
    }
    this.lastT = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
    }
    this.raf = 0;
  }

  /** Canvas size is only known after layout, so the panel calls this on render. */
  resize(): void {
    const c = this.canvas;
    const r = this.renderer;
    if (!c || !r) {
      return;
    }
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    r.setSize(w, h, false);
    const aspect = w / h;
    const cam = this.camera;
    cam.aspect = aspect;
    // Whichever distance is FURTHER wins, so both STAGE_W and STAGE_H fit.
    const tanV = Math.tan((cam.fov * Math.PI) / 360);
    cam.position.set(0, EYE_Y, Math.max(STAGE_W / 2 / (tanV * aspect), STAGE_H / 2 / tanV));
    cam.lookAt(0, LOOK_Y, 0);
    cam.updateProjectionMatrix();
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0.016;
    this.lastT = now;
    const r = this.renderer;
    if (!r) {
      return;
    }

    // Ahead of the live render, so a bake's target juggling is never on screen.
    if (this.bakeQueue.length) {
      this.bakeStep();
    }

    this.heroTime += dt;
    if (this.hero) {
      this.heroAnim.update(this.hero, heroIdle(this.heroTime, dt));
      // Held out, not slung — must come AFTER the animator, which owns
      // `sword.rotation.x/.z`. `armR` is left to it, or its idle sway fights.
      this.hero.sword.rotation.x = SHOW_X;
      this.hero.sword.rotation.z = SHOW_Z;
      this.hero.sword.rotation.y = SHOW_Y;
    }
    for (const s of this.onStage) {
      if (!s) {
        continue;
      }
      s.t += dt;
      s.rig.root.visible = true;
    }
    this.animateCast(dt);
    r.render(this.scene, this.camera);
  };

  private animateCast(dt: number): void {
    for (const s of this.onStage) {
      if (s) {
        s.species.animate(s.rig, beastCtx(s, dt));
      }
    }
  }

  dispose(): void {
    this.stop();
    if (this.pumpRaf) {
      cancelAnimationFrame(this.pumpRaf);
    }
    this.pumpRaf = 0;
    this.target?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
  }
}

/**
 * A fully idle `AnimInput`. Spelled out, not partial: `HeroAnimator.update`
 * reads every field and a missing one lands in a lerp as `undefined`.
 */
const IDLE_ATTACK = { active: false, combo: 0, t: 0, dur: 0.3 };
function heroIdle(time: number, dt: number): AnimInput {
  return {
    time,
    dt,
    moveNorm: 0,
    sprinting: false,
    onGround: true,
    swimming: false,
    climbing: false,
    climbRate: 0,
    riding: false,
    velY: 0,
    attack: IDLE_ATTACK,
    dead: false,
    deadT: 0,
    landBump: 0,
    hurtT: 0,
    unarmed: false,
    bow: false,
    stowed: false,
  };
}

function beastCtx(s: Subject, dt: number): BeastAnimCtx {
  return {
    action: "idle",
    actionTime: s.t,
    time: s.t,
    moveSpeed: IDLE_SPEED,
    dt,
    cycle: (slot, freq) => s.cycles.step(slot, freq, dt),
  };
}

/**
 * RGBA rows out of a render target, into a PNG data URI. The row flip is
 * mandatory: WebGL's origin is bottom-left, a canvas's is top-left.
 */
function toDataUrl(px: Uint8Array): string {
  const c = document.createElement("canvas");
  c.width = ICON;
  c.height = ICON;
  const ctx = c.getContext("2d");
  if (!ctx) {
    return "";
  }
  const img = ctx.createImageData(ICON, ICON);
  const row = ICON * 4;
  for (let y = 0; y < ICON; y++) {
    const src = (ICON - 1 - y) * row;
    img.data.set(px.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}
