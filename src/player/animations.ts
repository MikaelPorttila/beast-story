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
  climbing: boolean;
  /** Signed climb progress, -1 (descending) .. 1 (ascending); 0 = hanging. */
  climbRate: number;
  /** Sitting in a beast's saddle; MountController owns where the hero is. */
  riding: boolean;
  velY: number;
  attack: AttackState;
  dead: boolean;
  deadT: number;
  landBump: number;   // 0..1 squash impulse, decays in Player
  hurtT: number;      // countdown after taking a hit
  /**
   * Nothing in the hand. Picks the punch table over the sword one — see
   * `PUNCHES`. It is an INPUT rather than something read off the rig because
   * the animator is handed a rig and a state and reads nothing else.
   */
  unarmed: boolean;
  /**
   * A BOW in the hand. Picks the draw over the swing — see `DRAW`.
   *
   * Beside `unarmed` and for its reason: the animator reads a rig and a state
   * and nothing else. It is a second boolean rather than the `WeaponModelId`
   * itself because what the animator needs to know is which of three tables to
   * play, not which of five models is hanging in the hand — a scythe and a
   * dagger swing, and only these two do something else.
   */
  bow: boolean;
  /**
   * The weapon is on the back, not in the hand.
   *
   * The animator's one job here is to NOT write `rig.sword.rotation` while it
   * is true: the holster's own angle is the pose, and a swing keyframe applied
   * to a stowed weapon rotates it out of the hero's back. Everything else — the
   * hand it came off, the model in it — is `stowWeapon`'s business.
   */
  stowed: boolean;
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

/**
 * THE SAME THREE BEATS WITH NOTHING IN THE HAND.
 *
 * A swing keyframe is a SWORD ARC — a wide sweep with the shoulder rolled over
 * so the blade leads — and played with an empty fist it reads as a man
 * flailing. A punch is the opposite shape: the elbow comes back and the arm
 * goes STRAIGHT out, so the pose that matters is the one with `aRZ` near zero
 * and the torso turned into it. Three beats, alternating hands, because the
 * combo counter is shared with the armed path and a two-beat table would leave
 * the third tap doing nothing.
 *
 * `swX`/`swZ` are still written and are still ignored: there is nothing in the
 * mount to rotate. They are here because `SwingPose` is one shape and a second
 * one without them would fork `evalSwing`.
 */
const PUNCHES: Array<[SwingPose, SwingPose]> = [
  [ // 1: right jab — chamber at the hip, drive forward
    { aRX: -0.35, aRY: 0.15, aRZ: 0.12, aLX: -0.9, aLZ: -0.2, tY: 0.34, swX: 2.4, swZ: 0, bRX: -0.03, bY: 0.01 },
    { aRX: -1.75, aRY: -0.1, aRZ: 0.05, aLX: -0.2, aLZ: -0.35, tY: -0.34, swX: 2.4, swZ: 0, bRX: 0.16, bY: -0.03 },
  ],
  [ // 2: left cross — the other fist, so the torso unwinds the other way
    { aRX: -1.5, aRY: 0, aRZ: 0.08, aLX: -0.35, aLZ: -0.12, tY: -0.3, swX: 2.4, swZ: 0, bRX: 0, bY: 0.01 },
    { aRX: -0.25, aRY: 0.1, aRZ: 0.22, aLX: -1.8, aLZ: -0.06, tY: 0.4, swX: 2.4, swZ: 0, bRX: 0.18, bY: -0.03 },
  ],
  [ // 3: both hands, a shove that finishes the chain
    { aRX: -0.4, aRY: 0, aRZ: 0.3, aLX: -0.4, aLZ: -0.3, tY: 0, swX: 2.5, swZ: 0, bRX: -0.16, bY: 0.05 },
    { aRX: -1.9, aRY: 0, aRZ: 0.1, aLX: -1.9, aLZ: -0.1, tY: 0, swX: 2.5, swZ: 0, bRX: 0.3, bY: -0.09 },
  ],
];

/**
 * THE BOW: NOCK, DRAW, LOOSE — issue #118.
 *
 * A bow played through `SWINGS` is a man beating a monster with a stick, which
 * is what the issue is about; the arrow was already leaving the string (see
 * `arrowStrike`), and this is the half of it the player can see. Two poses like
 * a swing, so `evalSwing`'s machinery is reused unchanged, but they are read on
 * the bow's own clock — see `evalDraw`, and `BOW_RELEASE` in index.ts, which is
 * the frame the arrow actually leaves.
 *
 * HELD IN THE LEFT HAND, and `setWeaponModel` reparents the hand mount onto
 * `armL` to put it there — see hero-rig.ts. So this table is the one place in
 * the file where the LEFT arm leads and the right one is the working hand.
 *
 * `aLX` -1.62 is the bow arm straight out along the aim (-PI/2 is horizontal;
 * the swim cycle's -1.5 is the same neighbourhood), held nearly on the body's
 * centre line with `aLZ` near zero — an archer's bow arm is locked, and any
 * roll in it reads as the bow drifting off the shot. `aRZ` 1.3 lifts the
 * DRAWING elbow out to the side, which is the whole of what makes it archery
 * rather than a man pointing: `aRY` is the only second axis either shoulder
 * has, so "back" is mostly spelled with the roll.
 *
 * `swX` is the WEAPON in the hand, and it is the number this pose actually
 * turns on: the limbs have to STAND UP across the shot, or the bow reads as a
 * plank being carried. Captured from the gameplay camera with the arm already
 * out at -1.62: 0.55 lays the bow flat across his chest, 1.05 stands it up but
 * tilted back over the shoulder like a slung quiver, and 0.9 is vertical with
 * the arc ahead of the shoulder — which is the one that reads as drawn. (At
 * rest it is 2.62, hanging down the leg; every swing keyframe is 1.35 or more.)
 */
const DRAW: SwingPose = {
  aLX: -1.62, aLZ: -0.06, aRX: -0.3, aRY: -0.25, aRZ: 1.3,
  tY: -0.22, swX: 0.9, swZ: 0.1, bRX: 0.04, bY: 0,
};
/**
 * LOOSED. The bow arm holds its line — an archer does not drop the bow on the
 * release, and the shot reads as aimed only if the arm is still pointing where
 * the arrow went — while the drawing hand snaps open and back past the ear.
 */
const LOOSE: SwingPose = {
  aLX: -1.55, aLZ: -0.04, aRX: -0.05, aRY: -0.35, aRZ: 1.15,
  tY: -0.14, swX: 0.9, swZ: 0.1, bRX: 0.1, bY: -0.02,
};

const _swing: SwingPose = { ...READY };

/** Evaluate the keyframed swing pose at normalized phase p, into _swing. */
function evalSwing(combo: number, p: number, unarmed: boolean): SwingPose {
  const [wind, hit] = (unarmed ? PUNCHES : SWINGS)[combo];
  if (p < 0.32) return blend(READY, wind, easeOutCubic(seg(p, 0, 0.32)));
  return blend(wind, hit, easeInOut(seg(p, 0.32, 0.6)));
}

/**
 * Evaluate the bow's draw at normalized phase p, into _swing.
 *
 * SAME TWO-KEY SHAPE AS A SWING, DIFFERENT CLOCK, and the clock is the point.
 * A swing peaks early and follows through; a draw is slow to full tension and
 * then instant — so READY -> DRAW runs eased-out over the first 0.55 of the
 * cycle, which is `BOW_RELEASE` in index.ts and therefore exactly the frame the
 * arrow leaves, and DRAW -> LOOSE snaps over the 0.12 after it. The two numbers
 * are one number in two files: move the release frame and this segment moves
 * with it, or the string lets go before the hand does.
 */
function evalDraw(p: number): SwingPose {
  if (p < 0.55) return blend(READY, DRAW, easeOutCubic(seg(p, 0, 0.55)));
  return blend(DRAW, LOOSE, easeOutCubic(seg(p, 0.55, 0.67)));
}

/** Interpolate two keys into the shared scratch pose. Allocates nothing. */
function blend(from: SwingPose, to: SwingPose, t: number): SwingPose {
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
  private climbPhase = 0;
  private ridePhase = 0;

  // damped joint state
  private bodyY = 0; private bRX = 0; private bRZ = 0;
  private sclY = 1; private sclXZ = 1;
  private tY = 0;
  private hX = 0; private hY = 0;
  private aLX = 0; private aLZ = -0.08;
  private aRX = 0; private aRY = 0; private aRZ = 0.08;
  private lLX = 0; private lRX = 0;
  private hipX = 0;
  private swX = 2.28; private swZ = 0.14;

  update(rig: HeroRig, s: AnimInput): void {
    const t = s.time;
    const m = s.moveNorm;
    const dt = s.dt;

    if (m > 0.02 && (s.onGround || s.swimming)) {
      this.runPhase += dt * (5 + 8.5 * m) * (s.sprinting ? 1.18 : 1);
    }
    if (s.swimming) this.swimPhase += dt * (3.2 + 3.5 * m);
    // The climb cycle is driven by PROGRESS, not by a clock: it advances with
    // the hero's vertical rate and runs backwards when he descends, so the arm
    // that reached last is the one that gives the hold back. A hero simply
    // hanging still sways (the 0.9 floor) instead of freezing into a statue.
    if (s.climbing) {
      const r = s.climbRate;
      this.climbPhase += dt * (0.9 + 5.4 * Math.abs(r)) * (r < -0.02 ? -1 : 1);
    }
    // Saddle bob: a slow sway at rest that quickens with the mount's gait, so a
    // galloping fox jostles its rider and a parked one just breathes.
    if (s.riding) this.ridePhase += dt * (2.1 + 7.5 * m);

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
    // The hip block is ONE piece, so it cannot stride — it leans into the pace
    // and rocks a little against the boots, which is what sells a merged lower
    // body as legs. A quarter of the boot swing is enough to read; more and the
    // block visibly counter-rotates under a torso that is not following it.
    let hipX = 0.05 * m - gait * 0.06 * m;
    // Rest: blade hangs down and back. 2.28, not the 2.62 this was when the
    // hero had arms — the grip now sits at y 0.73 where the old rig held it at
    // 0.85, and at the old angle that put a sword's tip 0.12 under the ground.
    // Measured at the tip, not eyeballed; at 2.28 it clears at -0.02.
    let swX = 2.28 + 0.05 * Math.sin(t * 1.9 + 0.6) * idleW;
    let swZ = 0.14 * idleW;

    // ---- airborne ----
    // Riding is excluded: a flying mount holds the hero off the ground for
    // minutes at a time, and the falling-flail pose is for a hero with nothing
    // under him, not for one sitting in a saddle.
    if (!s.onGround && !s.swimming && !s.climbing && !s.riding) {
      const fall = clamp01((-s.velY + 3) / 10); // 0 rising -> 1 falling fast
      const flail = Math.sin(t * 9);
      aLX = lerp(-0.9, -0.25 + flail * 0.12, fall);
      aRX = lerp(-0.9, -0.25 - flail * 0.12, fall);
      aLZ = lerp(-0.35, -1.0, fall);
      aRZ = lerp(0.35, 1.0, fall);
      lLX = lerp(-0.5, -0.3, fall);
      lRX = lerp(0.65, 0.45, fall);
      hipX = lerp(0.12, -0.05, fall); // tuck on the way up, straighten on the way down
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
      // no hip target: `bRX` has already pitched the whole body flat, and the
      // block is a child of it
      tY = 0;
      swX = 2.6;
    }

    // ---- climbing ----
    // Same shape as the swim cycle: one phase, one sine, every joint written
    // from it. The hero is turned to face the rock by the Player, so "into the
    // wall" is local +z and reaching means rotating the shoulders past -PI/2
    // toward the -PI that points an arm straight up.
    //
    // Contralateral, like every other gait here: the arm that is high pairs with
    // the opposite leg, so the body is always braced on a diagonal — the hold
    // is hand + opposite foot, which is what stops the pose reading as a hug.
    if (s.climbing) {
      const cp = Math.sin(this.climbPhase);
      // Chest in, hips out: the small forward pitch is what keeps him ON the
      // face rather than floating a body-width off it at the camera's distance.
      bodyY = 0.02 * cp;
      bRX = 0.16;
      bRZ = cp * 0.05;
      tY = cp * 0.1;
      hX = -0.3;          // eyes up the face, looking for the next hold
      hY = cp * 0.1;
      // -2.45 rad is a high overhead reach (-PI would be dead vertical); the
      // +-0.45 swing is one arm reaching while the other pulls down past it.
      aRX = -2.45 + cp * 0.45;
      aLX = -2.45 - cp * 0.45;
      aRZ = 0.3;          // elbows out so the mitts land on the rock, not the ears
      aLZ = -0.3;
      aRY = 0;
      // Knees driven into the wall, alternating opposite the arms.
      lRX = 0.42 + cp * 0.34;
      lLX = 0.42 - cp * 0.34;
      hipX = 0.3;         // the block follows the boots into the rock
      swX = 2.45;         // blade stays slung along the back leg, out of the way
      swZ = 0.2;
    }

    // ---- riding ----
    // Astride, not standing on: the hip joints are the only leg articulation
    // this rig has (there is no knee), so the whole leg swings forward to just
    // past the horizontal — 1.18 rad — which from the follow camera reads as
    // thighs over the mount's shoulders with the shins hanging down its flank.
    // Anything past ~1.3 and the feet come up over the mount's head.
    //
    // The arms drop forward and inward onto an imaginary rein, and the whole
    // upper body pitches into the wind with speed. The sway is contralateral
    // with the mount's gait, as everywhere else here.
    if (s.riding) {
      const rp = Math.sin(this.ridePhase);
      bodyY = 0.02 * rp * (0.3 + m);
      bRX = 0.14 + 0.22 * m;
      bRZ = rp * 0.045 * (0.4 + m);
      tY = rp * 0.05;
      hX = -0.08 - 0.05 * m;
      hY = 0.06 * Math.sin(t * 0.4);
      aLX = -0.92 + rp * 0.07;
      aRX = -0.92 - rp * 0.07;
      aLZ = -0.14;
      aRZ = 0.14;
      aRY = 0;
      lLX = 1.18 + rp * 0.06;
      lRX = 1.18 - rp * 0.06;
      // The thigh block goes with the boots, but barely: it is wider than the
      // saddle and swinging it as far as they go pushes a corner of it out
      // past the mount's flank.
      hipX = 0.25;
      swX = 2.5;          // blade slung along the back, clear of the saddle
      swZ = 0.22;
    }

    // ---- attack: keyframed, blended over the base pose ----
    // The melee combo, the punch chain and the bow's draw all land here: one
    // blend, one fade, three tables. The bow holds its pose longer before it
    // gives the arms back (0.86 against 0.72) because a swing's follow-through
    // IS the end of the swing, while an archer's arm comes down after the shot
    // rather than as part of it.
    if (s.attack.active && !s.dead) {
      const p = clamp01(s.attack.t / s.attack.dur);
      const k = s.bow ? evalDraw(p) : evalSwing(s.attack.combo, p, s.unarmed);
      const w = 1 - easeInOut(seg(p, s.bow ? 0.86 : 0.72, 1)); // follow-through fade
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
        hipX = lerp(hipX, 0.04, w);
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
      // Hands IN, not flung out. Rolled wide they used to read as arms thrown
      // clear of the body; with no arm on them a mitt held out from a corpse
      // lying on its side is a ball hovering over the ground.
      aLZ = -0.12; aRZ = 0.16;
      aLX = -0.35; aRX = -0.4;
      lLX = -0.15; lRX = 0.2;
      hipX = 0.1;
      hX = 0.1; hY = 0.3;
      swX = 2.5;
    }

    // ---- squash & stretch ----
    let sclY = 1 - 0.26 * s.landBump;
    let sclXZ = 1 + 0.16 * s.landBump;
    if (!s.onGround && !s.swimming && !s.dead && !s.climbing && !s.riding) {
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
    this.hipX += (hipX - this.hipX) * kSlow;
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
    rig.hips.rotation.x = this.hipX;
    if (!s.stowed) {
      rig.sword.rotation.x = this.swX;
      rig.sword.rotation.z = this.swZ;
    }
  }
}
