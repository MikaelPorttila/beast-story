/**
 * CONTACT PARTICLES — what the world throws off when you brush against it. One
 * element exists: leaves off a tree crown, plus the snow that was sitting on it.
 * The system owns a FIXED POOL drawn as one InstancedMesh, the RECYCLING POLICY
 * (see `acquire`), the `ContactSource` list, and the SNOW OVERLAY (`snowShare`) —
 * a KIND rather than a source, taking a share of a burst that was going to happen
 * anyway. The dominant cost is one `world.getHeight` per FALLING particle.
 */
import * as THREE from "three";
import type { CrownContact, World, WorldBound } from "../core/types";
import { perf } from "../core/profiler";

/** Pool size, fixed forever: one sprinted traverse of a crown plus the last one's tail. */
const MAX = 64;

/** Particle states. Order matters only in that FREE is 0, so `fill(0)` clears. */
const FREE = 0;
const AIR = 1;
const SETTLED = 2;
const SHRINK = 3;

const TAU = Math.PI * 2;

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

/** Anything that can brush the world. `Player` and `BeastActor` both fit structurally. */
export interface ContactMover {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Horizontal half-width of the body, in world units. */
  readonly radius: number;
}

/** Where a burst happens and what it looks like. A SCRATCH: dead once spawned. */
interface ContactPoint {
  x: number;
  y: number;
  z: number;
  spread: number;
  /** Unit horizontal push direction — normally the way the mover was moving. */
  dirX: number;
  dirZ: number;
  /** Tint, in the renderer's working colour space. */
  color: THREE.Color;
  /** SNOW OVERLAY, 0..1: the share of this burst coming off as snow. A probability
   *  per particle (`pickKind`), filled by the source, which knows which COLUMN to ask. */
  snow: number;
}

interface ParticleKind {
  id: string;
  /** Fixed colour for a kind whose look is its own; LEAF takes ContactPoint.color. */
  tint?: THREE.Color;
  /** Longest / thickest / widest, in world units, before the per-particle roll. */
  long: number;
  thick: number;
  wide: number;
  sizeMin: number;
  sizeSpan: number;
  launch: number;
  launchUp: number;
  /** Horizontal drag, in the house `exp(-k*dt)` form. */
  drag: number;
  /** Exponential approach to `fall`, not a parabola: a leaf holds a drift speed. */
  fall: number;
  fallLambda: number;
  sway: number;
  swayHz: number;
  spin: number;
  restMin: number;
  restSpan: number;
  shrink: number;
  /** Faster shrink used when the pool is exhausted — see `acquire`. */
  shrinkFast: number;
  /** Watchdog: retire after this long airborne — only reachable with no ground under it. */
  maxAir: number;
}

interface ContactSource {
  readonly id: string;
  readonly kind: number;
  /** Snow-cover response: two ends of a smoothstep and a ceiling (`snowShare`). 0 opts out. */
  readonly snowFrom: number;
  readonly snowTo: number;
  readonly snowMax: number;
  readonly rate: number;
  readonly onset: number;
  /** Speed at which brushing is full-rate; zero standing still — contact is not disturbance. */
  readonly brushSpeed: number;
  /** Cheap, allocation-free. Fills `out` and returns true when touching. */
  probe(mover: ContactMover, world: World, out: ContactPoint): boolean;
}

const LEAF: ParticleKind = {
  id: "leaf",
  // A canopy VOXEL is 0.40-0.52 units and is a clump of foliage; a leaf is smaller.
  long: 1,
  thick: 0.14,
  wide: 0.72,
  sizeMin: 0.24,
  sizeSpan: 0.16,
  launch: 1.6,
  launchUp: 1.5,
  drag: 1.7,
  /** Drift speed, double a real leaf's: the honest 1.35 never let the pool turn over. */
  fall: 2.1,
  fallLambda: 2.4,
  sway: 0.85,
  swayHz: 0.75,
  spin: 3.4,
  restMin: 4,
  restSpan: 4,
  shrink: 0.5,
  shrinkFast: 0.22,
  maxAir: 14,
};

/**
 * SNOW off a snow-laden bough. An OVERLAY kind: no source, rate or contact test of
 * its own (`snowShare`). A lump rather than a plate, a slower driftier fall, half the
 * launch, and a short rest, which is what pays for the longer air time.
 */
const SNOW: ParticleKind = {
  id: "snow",
  // props.ts's pine cap opened up a stop: at its own albedo a flake reads ash-grey.
  tint: new THREE.Color().setHex(0xe8f2fa),
  long: 0.62,
  thick: 0.5,
  wide: 0.58,
  sizeMin: 0.26,
  sizeSpan: 0.26,
  launch: 0.85,
  launchUp: 0.55,
  drag: 2.8,
  fall: 1.55,
  fallLambda: 3.4,
  sway: 1.15,
  swayHz: 0.42,
  spin: 1.1,
  restMin: 1.6,
  restSpan: 1.8,
  // Longer than a leaf's 0.5: snow melts into the ground rather than being whisked.
  shrink: 0.8,
  shrinkFast: 0.22,
  maxAir: 14,
};

const KINDS: ParticleKind[] = [LEAF, SNOW];
const K_LEAF = 0;
const K_SNOW = 1;

/** Base foliage green off props.ts's bright half — a detached leaf is lit all round. */
const LEAF_BASE = 0x4c9e45;

/** Conifer needle green; the tint lerps here by cover, since above 0.5 every tree is a pine. */
const NEEDLE_COL = new THREE.Color().setHex(0x347f43);

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** What share of a burst comes off as snow. A BLEND, because cover is one, and it does
 *  NOT start at 0: the world only caps a pine past cover 0.5. Takes the COVER, not a
 *  column, so the source spends one sample and uses it twice. */
function snowShare(cover: number, s: ContactSource): number {
  if (s.snowMax <= 0) {
    return 0;
  }
  return s.snowMax * smoothstep(s.snowFrom, s.snowTo, cover);
}

/** Contact probe: how far up the hero's body the sphere sits, and how big. */
const CHEST_Y = 1.0;
const CHEST_PAD = 0.33;

/** Deterministic 0..1 from a tree's position, two independent rolls as props.ts does. */
function hash01(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

/** Leaves, the only implemented element. The contact test is a sphere at the hero's
 *  chest against the same canopy dome `climbTopAt` stands him on. */
const LEAVES: ContactSource = {
  id: "leaves",
  kind: K_LEAF,
  // Starts where props.ts swaps oaks for pines; full at 0.85, since cover flatlines early.
  snowFrom: 0.5,
  snowTo: 0.85,
  // 0.7, not 1.0: the dark needles are what give the white something to read against.
  snowMax: 0.7,
  rate: 18,
  onset: 5,
  brushSpeed: 2.2,
  probe(mover, world, out): boolean {
    const p = mover.position;
    const y = p.y + CHEST_Y;
    if (!world.crownContactAt(p.x, y, p.z, mover.radius + CHEST_PAD, _hit)) {
      return false;
    }
    out.x = p.x;
    out.y = y;
    out.z = p.z;
    out.spread = 0.45;
    // Outward from the trunk axis, falling back to the mover's heading at the axis.
    const dx = p.x - _hit.treeX;
    const dz = p.z - _hit.treeZ;
    const d = Math.hypot(dx, dz);
    if (d > 0.2) {
      out.dirX = dx / d;
      out.dirZ = dz / d;
    } else {
      const s = Math.hypot(mover.velocity.x, mover.velocity.z);
      out.dirX = s > 0.1 ? mover.velocity.x / s : 1;
      out.dirZ = s > 0.1 ? mover.velocity.z / s : 0;
    }
    // Per-TREE tint, rebuilt from the tree's position with props.ts's own algebra — the
    // registry does not carry the colour. One tree's leaves match, neighbours differ.
    const t = 0.85 + hash01(_hit.treeX, _hit.treeZ, 1) * 0.3;
    const hw = hash01(_hit.treeX, _hit.treeZ, 2) * 2 - 1;
    out.color.setHex(LEAF_BASE);
    // Sampled at the TRUNK: it is the tree that is under snow, and props.ts asked there.
    const cover = world.snowCoverAt(_hit.treeX, _hit.treeZ);
    out.snow = snowShare(cover, LEAVES);
    out.color.lerp(NEEDLE_COL, cover);
    out.color.r *= t * (1 + hw * 0.11);
    out.color.g *= t * (1 + hw * 0.02);
    out.color.b *= t * (1 - hw * 0.13);
    return true;
  },
};

const SOURCES: ContactSource[] = [LEAVES];

const _hit: CrownContact = {
  treeX: 0,
  treeZ: 0,
  crownR: 0,
  crownCy: 0,
  crownRy: 0,
};
const _point: ContactPoint = {
  x: 0,
  y: 0,
  z: 0,
  spread: 0,
  dirX: 0,
  dirZ: 0,
  color: new THREE.Color(),
  snow: 0,
};

/** The pool, the policy and the draw call. WorldBound because settled particles belong
 *  to the zone they fell in; `setWorld` clears the pool outright. */
export class TouchParticles implements WorldBound {
  readonly mesh: THREE.InstancedMesh;
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  /** Euler, applied XYZ. y is the leaf's thin axis, so rx/rz at 0 is lying flat. */
  private rx = new Float32Array(MAX);
  private ry = new Float32Array(MAX);
  private rz = new Float32Array(MAX);
  private spinX = new Float32Array(MAX);
  private spinY = new Float32Array(MAX);
  private spinZ = new Float32Array(MAX);
  /** Flutter: unit lateral direction, phase, and this particle's amplitude. */
  private swayX = new Float32Array(MAX);
  private swayZ = new Float32Array(MAX);
  private swayPh = new Float32Array(MAX);
  private swayAmp = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private state = new Uint8Array(MAX);
  /** Meaning depends on the state: age (AIR), rest left (SETTLED), fade left (SHRINK). */
  private timer = new Float32Array(MAX);
  private fade = new Float32Array(MAX);
  /** Which KINDS entry this is, not which SOURCE threw it: in the air, only the fall matters. */
  private knd = new Uint8Array(MAX);
  /** Settle order: a monotonic stamp, so "oldest settled" is one comparison. */
  private seq = new Float32Array(MAX);
  private seqNext = 1;

  private freeList = new Int16Array(MAX);
  private freeCount = MAX;
  /** Non-FREE particles. When it is 0 there is nothing to integrate or upload. */
  private live = 0;

  private acc = new Float32Array(SOURCES.length);
  private wasTouching = new Uint8Array(SOURCES.length);

  private dirty = false;
  private colorDirty = false;

  /** Instrumentation. Read through `stats()`; see __dbgTouchFx in main.ts. */
  private st = {
    spawned: 0,
    /** Bursts refused because every particle was in the air. */
    dropped: 0,
    /** Settled particles retired early to make room. Never one in flight. */
    retired: 0,
    /** THE INVARIANT: must stay 0 for the life of the process. */
    recycledAirborne: 0,
    /** Lifetime landings. `settled` in `stats()` is the live count, not this. */
    settledTotal: 0,
    maxAirborne: 0,
    maxLive: 0,
    /** Milliseconds in the last update, and the worst seen. `?perf=1` only. */
    ms: 0,
    msMax: 0,
  };

  /** Lifetime spawns per KIND: the mix is a coin flip, so counting states it honestly. */
  private kindSpawned = new Float64Array(KINDS.length);

  constructor(
    private scene: THREE.Scene,
    private world: World,
  ) {
    // ONE geometry for every element — plate, cube and droplet are this box rescaled.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Never culled: the warm-up only links programs for what is DRAWN (a 400 ms stall).
    this.mesh.frustumCulled = false;
    // Receives shadow, casts none: a leaf ignoring the canopy shadow glows under the tree.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;

    _mat4.makeScale(0, 0, 0);
    _col.setHex(LEAF_BASE);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, _mat4);
      // Colour NOW: instanceColor is in the program cache key, so a late one relinks.
      this.mesh.setColorAt(i, _col);
      this.freeList[i] = MAX - 1 - i;
    }
    scene.add(this.mesh);
  }

  /**
   * A slot for a new particle, or -1. THE RECYCLING POLICY: a FREE slot; else the
   * OLDEST SETTLED one goes into a fast shrink and this spawn is REFUSED (stealing it
   * would teleport a leaf resting in full view); else the spawn is DROPPED. An
   * airborne particle is never interrupted. The O(MAX) scan needs a full pool.
   */
  private acquire(): number {
    if (this.freeCount > 0) {
      const i = this.freeList[--this.freeCount];
      this.live++;
      if (this.live > this.st.maxLive) {
        this.st.maxLive = this.live;
      }
      return i;
    }
    let oldest = -1;
    let oldestSeq = Infinity;
    for (let i = 0; i < MAX; i++) {
      if (this.state[i] === SETTLED && this.seq[i] < oldestSeq) {
        oldestSeq = this.seq[i];
        oldest = i;
      }
    }
    if (oldest >= 0) {
      const k = KINDS[this.knd[oldest]];
      this.state[oldest] = SHRINK;
      this.timer[oldest] = k.shrinkFast;
      this.fade[oldest] = k.shrinkFast;
      this.st.retired++;
    } else {
      this.st.dropped++;
    }
    return -1;
  }

  /** Give a slot back. Never called on an airborne particle — see `st`. */
  private release(i: number): void {
    if (this.state[i] === AIR) {
      this.st.recycledAirborne++;
    }
    this.state[i] = FREE;
    this.freeList[this.freeCount++] = i;
    this.live--;
    _mat4.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _mat4);
    this.dirty = true;
  }

  /**
   * Which kind this particle comes out as. A COIN FLIP PER PARTICLE against
   * `pt.snow`: a second emitter would double the spawn rate on a snowy tree, which the
   * pool cannot absorb, so one budget is split and a snowy burst costs what a bare one does.
   */
  private pickKind(s: number, pt: ContactPoint): number {
    return pt.snow > 0 && Math.random() < pt.snow ? K_SNOW : SOURCES[s].kind;
  }

  private spawn(kn: number, pt: ContactPoint): boolean {
    const i = this.acquire();
    if (i < 0) {
      return false;
    }
    const k = KINDS[kn];

    // Scattered over the patch, sqrt-weighted so the disc fills evenly.
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * pt.spread;
    this.px[i] = pt.x + Math.cos(a) * r;
    this.py[i] = pt.y + (Math.random() - 0.5) * pt.spread;
    this.pz[i] = pt.z + Math.sin(a) * r;

    const sp = k.launch * (0.45 + Math.random() * 0.9);
    this.vx[i] = (pt.dirX * 0.8 + Math.cos(a) * 0.7) * sp;
    this.vz[i] = (pt.dirZ * 0.8 + Math.sin(a) * 0.7) * sp;
    this.vy[i] = k.launchUp * (0.25 + Math.random() * 0.9);

    this.rx[i] = Math.random() * TAU;
    this.ry[i] = Math.random() * TAU;
    this.rz[i] = Math.random() * TAU;
    this.spinX[i] = (Math.random() - 0.5) * 2 * k.spin;
    this.spinY[i] = (Math.random() - 0.5) * k.spin;
    this.spinZ[i] = (Math.random() - 0.5) * 2 * k.spin;

    const sa = Math.random() * TAU;
    this.swayX[i] = Math.cos(sa);
    this.swayZ[i] = Math.sin(sa);
    this.swayPh[i] = Math.random() * TAU;
    this.swayAmp[i] = k.sway * (0.55 + Math.random() * 0.9);

    this.size[i] = k.sizeMin + Math.random() * k.sizeSpan;
    this.state[i] = AIR;
    this.timer[i] = 0;
    this.knd[i] = kn;
    this.seq[i] = 0;

    // Per-particle value jitter, so one tree's leaves are a family, not 64 copies.
    const v = 0.86 + Math.random() * 0.28;
    _col.copy(k.tint ?? pt.color).multiplyScalar(v);
    this.mesh.setColorAt(i, _col);
    this.colorDirty = true;
    this.st.spawned++;
    this.kindSpawned[kn]++;
    return true;
  }

  /** Test every element against the mover and emit on contact. The onset burst is the
   *  impact, the rate is the brushing; standing still inside a crown sheds nothing. */
  private probeContacts(dt: number, mover: ContactMover): void {
    const speed = Math.hypot(mover.velocity.x, mover.velocity.y, mover.velocity.z);
    for (let s = 0; s < SOURCES.length; s++) {
      const src = SOURCES[s];
      if (!src.probe(mover, this.world, _point)) {
        this.wasTouching[s] = 0;
        this.acc[s] = 0;
        continue;
      }
      if (this.wasTouching[s] === 0) {
        this.wasTouching[s] = 1;
        for (let n = 0; n < src.onset; n++) {
          if (!this.spawn(this.pickKind(s, _point), _point)) {
            break;
          }
        }
      }
      const brush = Math.min(1, speed / src.brushSpeed);
      this.acc[s] += src.rate * brush * dt;
      while (this.acc[s] >= 1) {
        this.acc[s] -= 1;
        if (!this.spawn(this.pickKind(s, _point), _point)) {
          break;
        }
      }
      // A refused spawn must not bank credit, or the backlog dumps when a slot frees.
      if (this.acc[s] > 1) {
        this.acc[s] = 1;
      }
    }
  }

  /** Resting height: terrain, or the water surface over it — a leaf floats. The +0.05
   *  clears z-fighting and the residual tilt. */
  private settleY(x: number, z: number): number {
    const g = this.world.getHeight(x, z);
    return (g < this.world.waterLevel ? this.world.waterLevel : g) + 0.05;
  }

  /** One slice per non-free particle; exp forms, since several may drain in one frame. */
  private integrate(dt: number): void {
    if (this.live === 0) {
      return;
    }
    let airborne = 0;
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === FREE) {
        continue;
      }
      const k = KINDS[this.knd[i]];
      let s = this.size[i];

      if (st === AIR) {
        airborne++;
        this.timer[i] += dt;
        const d = Math.exp(-k.drag * dt);
        this.vx[i] *= d;
        this.vz[i] *= d;
        this.vy[i] += (-k.fall - this.vy[i]) * (1 - Math.exp(-k.fallLambda * dt));
        // Flutter goes on POSITION, not velocity: drag would eat it.
        this.swayPh[i] += k.swayHz * TAU * dt;
        const sw = Math.sin(this.swayPh[i]) * this.swayAmp[i];
        this.px[i] += (this.vx[i] + this.swayX[i] * sw) * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += (this.vz[i] + this.swayZ[i] * sw) * dt;
        this.rx[i] += this.spinX[i] * dt;
        this.ry[i] += this.spinY[i] * dt;
        this.rz[i] += this.spinZ[i] * dt;

        // The ground query is the most expensive thing here, so only while descending.
        if (this.vy[i] < 0) {
          const gy = this.settleY(this.px[i], this.pz[i]);
          if (this.py[i] <= gy) {
            this.py[i] = gy;
            this.state[i] = SETTLED;
            this.timer[i] = k.restMin + Math.random() * k.restSpan;
            this.seq[i] = this.seqNext++;
            this.st.settledTotal++;
            airborne--;
          }
        }
        if (this.state[i] === AIR && this.timer[i] > k.maxAir) {
          this.state[i] = SHRINK;
          this.timer[i] = k.shrink;
          this.fade[i] = k.shrink;
          airborne--;
        }
      } else if (st === SETTLED) {
        // Lie down: y is the thin axis, so damping rx/rz settles the leaf over a fifth of
        // a second — toward a RESIDUAL TILT, since perfectly flat leaves vanish edge-on.
        const lay = 1 - Math.exp(-14 * dt);
        this.rx[i] += (this.swayX[i] * 0.3 - this.rx[i]) * lay;
        this.rz[i] += (this.swayZ[i] * 0.3 - this.rz[i]) * lay;
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.state[i] = SHRINK;
          this.timer[i] = k.shrink;
          this.fade[i] = k.shrink;
        }
      } else {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          this.release(i);
          continue;
        }
        s *= this.timer[i] / this.fade[i];
      }

      _pos.set(this.px[i], this.py[i], this.pz[i]);
      _euler.set(this.rx[i], this.ry[i], this.rz[i]);
      _quat.setFromEuler(_euler);
      _scale.set(k.long * s, k.thick * s, k.wide * s);
      _mat4.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.dirty = true;
    if (airborne > this.st.maxAirborne) {
      this.st.maxAirborne = airborne;
    }
  }

  /** One slice. `mover` may be null: a modal freezes the hero, but leaves keep falling. */
  update(dt: number, mover: ContactMover | null): void {
    const t0 = perf.enabled ? performance.now() : 0;
    if (mover) {
      this.probeContacts(dt, mover);
    }
    this.integrate(dt);
    if (this.colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorDirty = false;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
    if (perf.enabled) {
      this.st.ms = performance.now() - t0;
      if (this.st.ms > this.st.msMax) {
        this.st.msMax = this.st.ms;
      }
    }
  }

  /** Wipe the pool — the ONE place an airborne particle is taken back, defensible only
   *  because the world it fell through has been replaced. Not an invariant break. */
  private clear(): void {
    this.state.fill(FREE);
    this.freeCount = MAX;
    for (let i = 0; i < MAX; i++) {
      this.freeList[i] = MAX - 1 - i;
    }
    this.live = 0;
    this.acc.fill(0);
    this.wasTouching.fill(0);
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, _mat4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  setWorld(world: World): void {
    this.world = world;
    this.clear();
  }

  /** Counts, not prose. `recycledAirborne` is the invariant, `retired` and `dropped`
   *  the two exhaustion paths, `spawned_<kind>` the snow mix's own proportion. */
  stats(): Record<string, number> {
    let air = 0;
    let settled = 0;
    let shrinking = 0;
    for (let i = 0; i < MAX; i++) {
      const s = this.state[i];
      if (s === AIR) {
        air++;
      } else if (s === SETTLED) {
        settled++;
      } else if (s === SHRINK) {
        shrinking++;
      }
    }
    const out: Record<string, number> = {
      pool: MAX,
      free: this.freeCount,
      airborne: air,
      settled,
      shrinking,
      live: this.live,
      ...this.st,
      ms: +this.st.ms.toFixed(4),
      msMax: +this.st.msMax.toFixed(4),
    };
    for (let k = 0; k < KINDS.length; k++) {
      out[`spawned_${KINDS[k].id}`] = this.kindSpawned[k];
    }
    return out;
  }

  /** TEST HOOK (__dbgTouchFx in main.ts): force `n` particles at the hero to drive the
   *  pool to exhaustion; returns how many were placed. Applies the snow overlay too. */
  forceBurst(mover: ContactMover, n: number): number {
    const s = 0; // leaves — the only source, and the only one with a snow ramp
    const p = mover.position;
    _point.x = p.x;
    _point.y = p.y + CHEST_Y + 1.6;
    _point.z = p.z;
    _point.spread = 0.6;
    _point.dirX = 1;
    _point.dirZ = 0;
    const cover = this.world.snowCoverAt(p.x, p.z);
    _point.snow = snowShare(cover, SOURCES[s]);
    _point.color.setHex(LEAF_BASE);
    _point.color.lerp(NEEDLE_COL, cover);
    let placed = 0;
    for (let i = 0; i < n; i++) {
      if (this.spawn(this.pickKind(s, _point), _point)) {
        placed++;
      }
    }
    return placed;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
