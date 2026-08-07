/**
 * A LOOK CHAIN — issue #2.
 *
 * Legs/base -> torso -> head -> the thing being looked at, with every joint
 * limited RELATIVE TO ITS PARENT rather than to the world. The chain owns the
 * constraint policy and nothing else: it is handed where the base is pointing
 * and where the actor wants to look, and it answers with three offsets plus the
 * yaw the CALLER still has to turn the base by. It touches no rig, so the same
 * object works for the hero, an NPC or a beast.
 *
 * Why a chain rather than a number in each animation: the alternative is every
 * pose in player/animations.ts writing its own clamped `torso.rotation.y`, and
 * then the limits live in a dozen keyframes and disagree. The animator poses,
 * this constrains, and the two are added.
 *
 * THE OVERFLOW RULE, which is the whole point:
 *  - the head takes what it can, up to its own limit;
 *  - what is left over goes to the torso, up to ITS limit;
 *  - what is left after that is `baseTurn`, and the legs turn to catch up.
 * `torsoLead` slides which end of that fills first — 0 is a glance (the head
 * goes first and the shoulders only follow when it runs out), 1 is an aim (the
 * torso goes first, because the arms hang off it and a bow that is not on the
 * torso is not pointing at anything).
 *
 * SMOOTHNESS is structural, not a special case. `distribute` is continuous in
 * its argument — the clamps meet the identity at the limit — so a target
 * crossing a boundary moves the joints at the same rate on both sides of it,
 * and every joint is then damped with `1 - exp(-lambda*dt)` so the frame rate
 * cannot change the shape of the motion.
 */

export interface LookChainConfig {
  /** Max torso yaw off the legs, radians. */
  torsoYaw: number;
  /** Max head yaw off the torso, radians. */
  headYaw: number;
  /** Max head pitch off the torso, radians; positive looks DOWN. */
  headPitch: number;
  /** 0 = the head leads the turn (a glance), 1 = the torso leads it (an aim). */
  torsoLead: number;
  /** Damping rate toward a tracked target. */
  track: number;
  /** Damping rate back to neutral once tracking stops. */
  release: number;
  /** Damping rate of the base catch-up once the chain is out of slack. */
  base: number;
}

/** What the chain is looking at, in WORLD yaw/pitch. */
export interface LookTarget {
  yaw: number;
  /** Positive looks DOWN, matching `rotation.x` on a head pivot. */
  pitch: number;
}

const clampAbs = (v: number, limit: number): number =>
  (v < -limit ? -limit : v > limit ? limit : v);

/** Shortest signed arc for an angle difference, radians. */
export function shortestArc(d: number): number {
  let a = d;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class LookChain {
  /** Torso yaw offset from the legs, radians. Additive over the animation. */
  torsoYaw = 0;
  /** Head yaw offset from the torso, radians. */
  headYaw = 0;
  /** Head pitch offset from the torso, radians; positive is down. */
  headPitch = 0;
  /**
   * Yaw the caller must add to the base THIS FRAME, radians. The chain cannot
   * turn the legs itself — they are the actor's movement direction and belong
   * to whatever is driving it — so the catch-up is reported, not applied.
   */
  baseTurn = 0;

  /** Solved targets, kept off the damped state so `update` allocates nothing. */
  private wantTorso = 0;
  private wantHead = 0;

  constructor(readonly cfg: LookChainConfig) {}

  /** Back to neutral with no easing. Session reset, teleport, respawn. */
  reset(): void {
    this.torsoYaw = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.baseTurn = 0;
    this.wantTorso = 0;
    this.wantHead = 0;
  }

  /**
   * The base was turned by `delta` from outside the chain (a lunge snapping the
   * hero onto his swing). Absorb it so the actor's WORLD orientation does not
   * jump: the offsets carry the same total, measured from the new base.
   *
   * Without this a snap of the legs drags the shoulders and the head round with
   * them by the same angle in a single frame, which is the "sudden rotation"
   * the whole constraint system exists to avoid.
   */
  rebase(delta: number): void {
    const total = this.torsoYaw + this.headYaw - delta;
    this.distribute(total);
    this.torsoYaw = this.wantTorso;
    this.headYaw = this.wantHead;
  }

  /**
   * Solve and damp one frame.
   *
   * `target` null means "stop tracking": the joints ease back to neutral at
   * `release` instead of `track`, which is a slower unwind than the snap onto a
   * target — a head comes round fast and drifts back slow.
   */
  update(dt: number, baseYaw: number, target: LookTarget | null): void {
    const c = this.cfg;
    let leftover = 0;
    let wantPitch = 0;
    if (target) {
      leftover = this.distribute(shortestArc(target.yaw - baseYaw));
      wantPitch = clampAbs(target.pitch, c.headPitch);
    } else {
      this.wantTorso = 0;
      this.wantHead = 0;
    }
    const k = 1 - Math.exp(-(target ? c.track : c.release) * dt);
    this.torsoYaw += (this.wantTorso - this.torsoYaw) * k;
    this.headYaw += (this.wantHead - this.headYaw) * k;
    this.headPitch += (wantPitch - this.headPitch) * k;
    // The catch-up is a RATE, not the whole leftover: the legs chase the last
    // of the turn instead of teleporting onto it, so a target far off the back
    // is answered by the shoulders first and the feet a moment later.
    this.baseTurn = leftover * (1 - Math.exp(-c.base * dt));
  }

  /**
   * Split a total world-space yaw offset across the two joints, into
   * `wantTorso`/`wantHead`, and return what neither could take.
   */
  private distribute(total: number): number {
    const c = this.cfg;
    let torso = clampAbs(total * c.torsoLead, c.torsoYaw);
    const head = clampAbs(total - torso, c.headYaw);
    // Whatever the head could not take goes back to the torso, up to its limit.
    torso = clampAbs(total - head, c.torsoYaw);
    this.wantTorso = torso;
    this.wantHead = head;
    return total - torso - head;
  }
}
