import * as THREE from 'three';
import type { CelestialState, TimeOfDaySource } from './types';

/** One complete game day in active-play seconds. */
export const DAY_SECONDS = 30 * 60;
/** Noon is defined to reproduce the fixed daylight rig issue #87 replaces. */
export const INITIAL_DAY_PHASE = 0.5;

const TAU = Math.PI * 2;
const MAX_ELEVATION = Math.atan2(160, Math.hypot(170, 113));
const NOON_AZIMUTH = Math.atan2(170, 113);
const TRANSITION_SECONDS = 1;

const DAY_KEY = new THREE.Color(0xffebbe);
const TWILIGHT_KEY = new THREE.Color(0xff9b62);
const NIGHT_KEY = new THREE.Color(0x91b8ff);
const DAY_BOUNCE = new THREE.Color(0xd7cfa6);
const NIGHT_BOUNCE = new THREE.Color(0x5374a8);
const DAY_SKY = new THREE.Color(0xb4d6fb);
const NIGHT_SKY = new THREE.Color(0x294872);
const DAY_GROUND = new THREE.Color(0x8fa4bd);
const NIGHT_GROUND = new THREE.Color(0x17263f);
const WHITE = new THREE.Color(1, 1, 1);
const TWILIGHT_FILTER = new THREE.Color(2.20, 0.74, 0.28);
const NIGHT_FILTER = new THREE.Color(0.075, 0.16, 0.36);

const wrap = (v: number): number => ((v % 1) + 1) % 1;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, v: number): number => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const circularDelta = (from: number, to: number): number => {
  let d = wrap(to) - wrap(from);
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
};

/**
 * Session clock and the single environmental answer derived from it.
 *
 * The object itself is the stable CelestialState passed through the composition
 * root. All vectors and colours are mutated in place, so one visual update costs
 * no garbage however many consumers read it.
 */
export class DayNightCycle implements CelestialState {
  phase = INITIAL_DAY_PHASE;
  source: TimeOfDaySource = 'auto';
  quest: string | null = null;

  readonly sunDirection = new THREE.Vector3();
  readonly moonDirection = new THREE.Vector3();
  readonly keyDirection = new THREE.Vector3();
  readonly keyColor = new THREE.Color();
  keyIntensity = 3.05;
  readonly bounceColor = new THREE.Color();
  bounceIntensity = 0.38;
  readonly ambientSky = new THREE.Color();
  readonly ambientGround = new THREE.Color();
  ambientIntensity = 0.55;
  readonly atmosphereFilter = new THREE.Color(1, 1, 1);
  exposureScale = 1;
  daylight = 1;
  night = 0;
  stars = 0;
  moon = 0;

  private runningPhase = INITIAL_DAY_PHASE;
  private questPhase: number | null = null;
  private questId: string | null = null;
  private debugPhase: number | null = null;
  private transitionFrom = INITIAL_DAY_PHASE;
  private transitionTo = INITIAL_DAY_PHASE;
  private transitionT = TRANSITION_SECONDS;

  constructor() {
    this.derive();
  }

  /** Advance once per rendered frame. Pins pause rather than hiding the clock. */
  update(dt: number): void {
    const target = this.pinTarget();
    if (target !== null) {
      this.runningPhase = target;
      if (this.transitionT < TRANSITION_SECONDS) {
        this.transitionT = Math.min(TRANSITION_SECONDS, this.transitionT + Math.max(0, dt));
        const u = this.transitionT / TRANSITION_SECONDS;
        const eased = u * u * (3 - 2 * u);
        this.phase = wrap(this.transitionFrom + circularDelta(this.transitionFrom, this.transitionTo) * eased);
      } else {
        this.phase = target;
      }
    } else {
      this.runningPhase = wrap(this.runningPhase + Math.max(0, dt) / DAY_SECONDS);
      this.phase = this.runningPhase;
    }
    this.derive();
  }

  setQuestOverride(id: string | null, phase: number | null): void {
    const next = phase === null ? null : wrap(phase);
    if (this.questId === id && this.questPhase === next) return;
    this.questId = id;
    this.questPhase = next;
    this.retarget();
  }

  setDebugOverride(phase: number | null): void {
    const next = phase === null ? null : wrap(phase);
    if (this.debugPhase === next) return;
    this.debugPhase = next;
    this.retarget();
  }

  get debugOverride(): number | null { return this.debugPhase; }
  get questOverride(): number | null { return this.questPhase; }

  reset(): void {
    this.runningPhase = INITIAL_DAY_PHASE;
    this.phase = INITIAL_DAY_PHASE;
    this.questPhase = null;
    this.questId = null;
    this.debugPhase = null;
    this.transitionFrom = INITIAL_DAY_PHASE;
    this.transitionTo = INITIAL_DAY_PHASE;
    this.transitionT = TRANSITION_SECONDS;
    this.derive();
  }

  private pinTarget(): number | null {
    return this.debugPhase ?? this.questPhase;
  }

  private retarget(): void {
    const target = this.pinTarget();
    if (target === null) {
      this.runningPhase = this.phase;
      this.transitionT = TRANSITION_SECONDS;
      return;
    }
    this.transitionFrom = this.phase;
    this.transitionTo = target;
    this.transitionT = 0;
    this.runningPhase = target;
  }

  private derive(): void {
    const solar = TAU * (this.phase - 0.25);
    const elevation = Math.sin(solar) * MAX_ELEVATION;
    const azimuth = NOON_AZIMUTH + TAU * (this.phase - 0.5);
    const horizontal = Math.cos(elevation);
    this.sunDirection.set(
      horizontal * Math.sin(azimuth),
      Math.sin(elevation),
      horizontal * Math.cos(azimuth),
    ).normalize();
    this.moonDirection.copy(this.sunDirection).multiplyScalar(-1);

    // A broad shoulder through the horizon prevents a dead interval where the
    // sun has stopped lighting the world but the moon has not taken over yet.
    // At the exact dawn/dusk preset this is 0.43: clearly twilight, still
    // playable, and far below noon's full daylight.
    const sunUp = smoothstep(-0.10, 0.12, this.sunDirection.y);
    const moonUp = smoothstep(-0.04, 0.18, this.moonDirection.y);
    this.daylight = sunUp;
    this.night = moonUp;
    this.stars = smoothstep(0.02, 0.30, this.moonDirection.y);
    this.moon = this.moonDirection.y > -0.04 ? 0.12 + this.night * 0.88 : 0;

    const sunOwnsKey = this.sunDirection.y >= -0.02;
    this.keyDirection.copy(sunOwnsKey ? this.sunDirection : this.moonDirection);
    const twilight = (1 - smoothstep(0.04, 0.34, Math.abs(this.sunDirection.y))) * sunUp;
    this.keyColor.copy(sunOwnsKey ? DAY_KEY : NIGHT_KEY);
    if (sunOwnsKey) this.keyColor.lerp(TWILIGHT_KEY, twilight * 0.72);
    this.keyIntensity = sunOwnsKey
      ? 0.18 + 2.87 * sunUp
      : 0.12 + 0.68 * moonUp;

    this.bounceColor.copy(NIGHT_BOUNCE).lerp(DAY_BOUNCE, sunUp);
    // 0.36 at midnight is the face fill measured against the issue #87 rear-key
    // capture: 0.10 let the moon-facing side read, and 0.24 still left the skin
    // nearly black in the supplied worst-case angle. Keep it below half of the
    // 0.8 moon key so night retains a clear direction.
    this.bounceIntensity = 0.36 + 0.02 * sunUp;
    this.ambientSky.copy(NIGHT_SKY).lerp(DAY_SKY, sunUp);
    this.ambientGround.copy(NIGHT_GROUND).lerp(DAY_GROUND, sunUp);
    this.ambientIntensity = 0.34 + 0.21 * sunUp;

    this.atmosphereFilter.copy(NIGHT_FILTER).lerp(WHITE, sunUp);
    if (sunOwnsKey) this.atmosphereFilter.lerp(TWILIGHT_FILTER, twilight * 0.65);
    this.exposureScale = 0.76 + 0.24 * sunUp;
    this.source = this.debugPhase !== null ? 'debug' : this.questPhase !== null ? 'quest' : 'auto';
    this.quest = this.source === 'quest' ? this.questId : null;
  }
}
