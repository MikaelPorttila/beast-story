import type { HeroRig } from './hero-rig';

/** Live attack state fed in by the Player each frame. */
export interface AttackState {
  active: boolean;
  combo: number; // 0..2
  t: number;     // seconds into current swing
  dur: number;   // swing duration
}

/** Everything the animator needs to pose the hero for one frame. */
export interface AnimInput {
  time: number;
  dt: number;
  moveNorm: number;   // 0..1
  sprinting: boolean;
  onGround: boolean;
  swimming: boolean;
  velY: number;
  attack: AttackState;
  dead: boolean;
  deadT: number;
  landBump: number;   // 0..1 squash impulse, decays in Player
  hurtT: number;      // countdown after taking a hit
}

// -- easing ----------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (p: number, a: number, b: number): number => clamp01((p - a) / (b - a));
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function easeOutBounce(t: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1; return n1 * t * t + 0.984375;
}

// -- attack keyframes ------------------------------------------------------
interface SwingPose {
  aRX: number; aRY: number; aRZ: number;
  aLX: number; aLZ: number;
  tY: number; swX: number; swZ: number;
  bRX: number; bY: number;
}

const READY: SwingPose = { aRX: -0.5, aRY: 0, aRZ: 0.3, aLX: -0.35, aLZ: -0.35, tY: 0.12, swX: 2.0, swZ: 0, bRX: 0.06, bY: 0 };

// [windup, strike-end] per combo hit
const SWINGS: Array<[SwingPose, SwingPose]> = [
  [ // 1: slash right -> left
    { aRX: -1.1, aRY: -0.3, aRZ: 1.5, aLX: -0.2, aLZ: -0.5, tY: 0.5, swX: 1.7, swZ: -0.4, bRX: -0.04, bY: 0.02 },
    { aRX: -1.35, aRY: 0.5, aRZ: -1.1, aLX: 0.45, aLZ: -0.25, tY: -0.55, swX: 1.5, swZ: 0.35, bRX: 0.22, bY: -0.04 },
  ],
  [ // 2: backhand left -> right
    { aRX: -1.35, aRY: 0.4, aRZ: -1.2, aLX: 0.3, aLZ: -0.3, tY: -0.5, swX: 1.55, swZ: 0.4, bRX: 0, bY: 0.02 },
    { aRX: -1.0, aRY: -0.4, aRZ: 1.45, aLX: -0.4, aLZ: -0.55, tY: 0.55, swX: 1.7, swZ: -0.4, bRX: 0.2, bY: -0.04 },
  ],
  [ // 3: big overhead chop
    { aRX: -3.1, aRY: 0, aRZ: 0.25, aLX: -1.2, aLZ: -0.6, tY: 0.15, swX: 3.0, swZ: 0, bRX: -0.14, bY: 0.05 },
    { aRX: -0.3, aRY: 0, aRZ: 0.1, aLX: 0.5, aLZ: -0.4, tY: 0, swX: 1.35, swZ: 0, bRX: 0.3, bY: -0.1 },
  ],
];

const _swing: SwingPose = { ...READY };

/** Evaluate the keyframed swing pose at normalized phase p, into _swing. */
function evalSwing(combo: number, p: number): SwingPose {
  const [wind, hit] = SWINGS[combo];
  let from: SwingPose, to: SwingPose, t: number;
  if (p < 0.32) {
    from = READY; to = wind; t = easeOutCubic(seg(p, 0, 0.32));
  } else {
    from = wind; to = hit; t = easeInOut(seg(p, 0.32, 0.6));
  }
  _swing.aRX = lerp(from.aRX, to.aRX, t);
  _swing.aRY = lerp(from.aRY, to.aRY, t);
  _swing.aRZ = lerp(from.aRZ, to.aRZ, t);
  _swing.aLX = lerp(from.aLX, to.aLX, t);
  _swing.aLZ = lerp(from.aLZ, to.aLZ, t);
  _swing.tY = lerp(from.tY, to.tY, t);
  _swing.swX = lerp(from.swX, to.swX, t);
  _swing.swZ = lerp(from.swZ, to.swZ, t);
  _swing.bRX = lerp(from.bRX, to.bRX, t);
  _swing.bY = lerp(from.bY, to.bY, t);
  return _swing;
}

/**
 * Procedural hero animator. Computes per-joint target angles every frame
 * (idle / run / sprint / jump / fall / swim / melee combo / death) and eases
 * the rig toward them so every transition is smooth.
 */
export class HeroAnimator {
  private runPhase = 0;
  private swimPhase = 0;

  // damped joint state
  private bodyY = 0; private bRX = 0; private bRZ = 0;
  private sclY = 1; private sclXZ = 1;
  private tY = 0;
  private hX = 0; private hY = 0;
  private aLX = 0; private aLZ = -0.08;
  private aRX = 0; private aRY = 0; private aRZ = 0.08;
  private lLX = 0; private lRX = 0;
  private swX = 2.62; private swZ = 0.14;

  update(rig: HeroRig, s: AnimInput): void {
    const t = s.time;
    const m = s.moveNorm;
    const dt = s.dt;

    if (m > 0.02 && (s.onGround || s.swimming)) {
      this.runPhase += dt * (5 + 8.5 * m) * (s.sprinting ? 1.18 : 1);
    }
    if (s.swimming) this.swimPhase += dt * (3.2 + 3.5 * m);

    // ---- base locomotion targets ----
    const breath = Math.sin(t * 1.9);
    const gait = Math.sin(this.runPhase);
    const idleW = clamp01(1 - m * 3); // idle details fade fast once moving

    let bodyY = 0.012 * breath * idleW - 0.03 * Math.abs(Math.cos(this.runPhase)) * m + 0.03 * m;
    let bRX = 0.02 + 0.12 * m + (s.sprinting && m > 0.5 ? 0.14 : 0);
    let bRZ = gait * 0.03 * m;
    let tY = 0.05 * Math.sin(t * 0.7) * idleW;
    let hX = 0.04 * Math.sin(t * 0.9) * idleW - 0.06 * m;
    let hY = 0.12 * Math.sin(t * 0.33) * idleW;
    let aLX = -gait * 0.75 * m + 0.05 * Math.sin(t * 1.9 + 1.2) * idleW;
    let aLZ = -0.1 - 0.05 * m;
    let aRX = gait * 0.75 * m + 0.05 * Math.sin(t * 1.9) * idleW;
    let aRY = 0;
    let aRZ = 0.1 + 0.05 * m;
    let lLX = gait * 0.85 * m;
    let lRX = -gait * 0.85 * m;
    // rest: blade hangs down alongside the leg, tucked slightly back
    let swX = 2.62 + 0.05 * Math.sin(t * 1.9 + 0.6) * idleW;
    let swZ = 0.14 * idleW;

    // ---- airborne ----
    if (!s.onGround && !s.swimming) {
      const fall = clamp01((-s.velY + 3) / 10); // 0 rising -> 1 falling fast
      const flail = Math.sin(t * 9);
      aLX = lerp(-0.9, -0.25 + flail * 0.12, fall);
      aRX = lerp(-0.9, -0.25 - flail * 0.12, fall);
      aLZ = lerp(-0.35, -1.0, fall);
      aRZ = lerp(0.35, 1.0, fall);
      lLX = lerp(-0.5, -0.3, fall);
      lRX = lerp(0.65, 0.45, fall);
      bRX = lerp(0.12, -0.06, fall);
      hX = lerp(-0.15, 0.12, fall);
      swX = 2.3;
    }

    // ---- swimming ----
    if (s.swimming) {
      const sp = this.swimPhase;
      bodyY = 0.52 + Math.sin(t * 1.6) * 0.03;
      bRX = 1.22;
      bRZ = Math.sin(sp) * 0.06;
      hX = -1.05;
      hY = Math.sin(sp * 0.5) * 0.12;
      aRX = -1.5 + Math.sin(sp) * (0.5 + 0.6 * m);
      aLX = -1.5 + Math.sin(sp + Math.PI) * (0.5 + 0.6 * m);
      aRZ = 0.5;
      aLZ = -0.5;
      aRY = 0;
      lLX = Math.sin(sp * 2.3) * (0.3 + 0.3 * m);
      lRX = -Math.sin(sp * 2.3) * (0.3 + 0.3 * m);
      tY = 0;
      swX = 2.6;
    }

    // ---- melee combo: keyframed, blended over the base pose ----
    if (s.attack.active && !s.dead) {
      const p = clamp01(s.attack.t / s.attack.dur);
      const k = evalSwing(s.attack.combo, p);
      const w = 1 - easeInOut(seg(p, 0.72, 1)); // follow-through fade
      aRX = lerp(aRX, k.aRX, w);
      aRY = lerp(aRY, k.aRY, w);
      aRZ = lerp(aRZ, k.aRZ, w);
      aLX = lerp(aLX, k.aLX, w);
      aLZ = lerp(aLZ, k.aLZ, w);
      tY = lerp(tY, k.tY, w);
      swX = lerp(swX, k.swX, w);
      swZ = lerp(swZ, k.swZ, w);
      bRX = lerp(bRX, k.bRX, w);
      bodyY += k.bY * w;
      if (s.onGround && m < 0.3) { // combat stance feet
        lLX = lerp(lLX, -0.28, w);
        lRX = lerp(lRX, 0.34, w);
      }
    }

    // ---- hurt flinch ----
    if (s.hurtT > 0) {
      const f = s.hurtT / 0.25;
      bRX -= 0.3 * f;
      hX -= 0.25 * f;
    }

    // ---- death: keel over with a bounce ----
    if (s.dead) {
      const fallT = easeOutBounce(clamp01(s.deadT / 0.85));
      bRZ = 1.52 * fallT;
      bRX = 0;
      bodyY = -0.04 * fallT;
      tY = 0;
      aLZ = -0.5; aRZ = 0.55;
      aLX = -0.2; aRX = -0.25;
      lLX = -0.15; lRX = 0.2;
      hX = 0.1; hY = 0.3;
      swX = 2.5;
    }

    // ---- squash & stretch ----
    let sclY = 1 - 0.26 * s.landBump;
    let sclXZ = 1 + 0.16 * s.landBump;
    if (!s.onGround && !s.swimming && !s.dead) {
      const stretch = clamp01(Math.abs(s.velY) * 0.016) * 0.07;
      sclY = 1 + stretch;
      sclXZ = 1 - stretch * 0.6;
    }

    // ---- ease everything toward targets ----
    const atk = s.attack.active || s.dead;
    const kSlow = 1 - Math.exp(-14 * dt);
    const kFast = 1 - Math.exp(-28 * dt);
    const kArm = atk ? kFast : kSlow;

    this.bodyY += (bodyY - this.bodyY) * kSlow;
    this.bRX += (bRX - this.bRX) * kArm;
    this.bRZ += (bRZ - this.bRZ) * (s.dead ? kFast : kSlow);
    this.sclY += (sclY - this.sclY) * kFast;
    this.sclXZ += (sclXZ - this.sclXZ) * kFast;
    this.tY += (tY - this.tY) * kArm;
    this.hX += (hX - this.hX) * kSlow;
    this.hY += (hY - this.hY) * kSlow;
    this.aLX += (aLX - this.aLX) * kArm;
    this.aLZ += (aLZ - this.aLZ) * kArm;
    this.aRX += (aRX - this.aRX) * kArm;
    this.aRY += (aRY - this.aRY) * kArm;
    this.aRZ += (aRZ - this.aRZ) * kArm;
    this.lLX += (lLX - this.lLX) * kSlow;
    this.lRX += (lRX - this.lRX) * kSlow;
    this.swX += (swX - this.swX) * kArm;
    this.swZ += (swZ - this.swZ) * kArm;

    // ---- apply to rig ----
    rig.body.position.y = this.bodyY;
    rig.body.rotation.x = this.bRX;
    rig.body.rotation.z = this.bRZ;
    rig.body.scale.set(this.sclXZ, this.sclY, this.sclXZ);
    rig.torso.rotation.y = this.tY;
    rig.head.rotation.x = this.hX;
    rig.head.rotation.y = this.hY;
    rig.armL.rotation.x = this.aLX;
    rig.armL.rotation.z = this.aLZ;
    rig.armR.rotation.x = this.aRX;
    rig.armR.rotation.y = this.aRY;
    rig.armR.rotation.z = this.aRZ;
    rig.legL.rotation.x = this.lLX;
    rig.legR.rotation.x = this.lRX;
    rig.sword.rotation.x = this.swX;
    rig.sword.rotation.z = this.swZ;
  }
}
