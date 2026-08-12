import * as THREE from 'three';
import type { FetchJob, World } from '../core/types';
import { SHARD_ID, itemDef } from '../core/items';
import type { VFX } from './vfx';

// A drop CLAIMED as a `FetchJob` stops answering the player's magnet, or the
// beast fetching it jogs to empty grass.

const CORE_HEX = 0xeafffb;
const MAGNET_RANGE_SQ = 9;      // 3 units
const COLLECT_DIST_SQ = 0.45;
const MAX_AGE = 42;

const _v = new THREE.Vector3();

interface Drop {
  active: boolean;
  group: THREE.Group;
  mesh: THREE.Mesh;
  core: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshBasicMaterial;
  glowMat: THREE.SpriteMaterial;
  vel: THREE.Vector3;
  age: number;
  seed: number;
  grounded: boolean;
  itemId: string;
  claimed: boolean;
  /** False for a thrown-away drop until the player leaves magnet range once. */
  armed: boolean;
  gen: number;   // bumped on every (re)use, so stale jobs go inert
  job: DropJob;
}

// Generation-checked, so a stale job goes invalid rather than wrong.
class DropJob implements FetchJob {
  private gen = -1;

  constructor(private drop: Drop, private collectFn: (d: Drop, byBeast: boolean) => void) {}

  get itemId(): string { return this.drop.itemId; }
  get position(): THREE.Vector3 { return this.drop.group.position; }
  get valid(): boolean { return this.drop.active && this.drop.gen === this.gen; }

  claim(): boolean {
    if (!this.drop.active || this.drop.claimed) return false;
    this.drop.claimed = true;
    this.gen = this.drop.gen;
    return true;
  }

  collect(): void {
    if (!this.valid) return;
    this.gen = -1;
    this.collectFn(this.drop, true);
  }

  release(): void {
    if (this.valid) this.drop.claimed = false;
    this.gen = -1;
  }
}

export class Pickups {
  private pool: Drop[] = [];
  private shardGeo: THREE.OctahedronGeometry;
  private coreGeo: THREE.OctahedronGeometry;
  private cubeGeo: THREE.BoxGeometry;
  private cubeCoreGeo: THREE.BoxGeometry;

  constructor(
    private scene: THREE.Scene,
    private vfx: VFX,
    private onCollect: (itemId: string, byBeast: boolean) => void,
  ) {
    this.shardGeo = new THREE.OctahedronGeometry(0.16, 0);
    this.shardGeo.scale(1, 1.65, 1);
    this.coreGeo = new THREE.OctahedronGeometry(0.085, 0);
    this.coreGeo.scale(1, 1.65, 1);
    this.cubeGeo = new THREE.BoxGeometry(0.24, 0.24, 0.24);
    this.cubeCoreGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  }

  private slot(): Drop | null {
    for (const s of this.pool) if (!s.active) return s;
    if (this.pool.length >= 48) return null;
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: CORE_HEX, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const glowMat = new THREE.SpriteMaterial({
      map: this.vfx.glowTexture, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const group = new THREE.Group();
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(0.95);
    const mesh = new THREE.Mesh(this.shardGeo, mat);
    const core = new THREE.Mesh(this.coreGeo, coreMat);
    glow.renderOrder = 16; mesh.renderOrder = 17; core.renderOrder = 18;
    group.add(glow);
    group.add(mesh);
    group.add(core);
    group.visible = false;
    this.scene.add(group);
    const s: Drop = {
      active: false, group, mesh, core, mat, coreMat, glowMat,
      vel: new THREE.Vector3(), age: 0, seed: 0, grounded: false,
      itemId: SHARD_ID, claimed: false, armed: true, gen: 0,
      job: null as unknown as DropJob,
    };
    s.job = new DropJob(s, (d, byBeast) => this.take(d, byBeast));
    this.pool.push(s);
    return s;
  }

  // `armed: false` (the inventory's Drop) is ignored until the player leaves
  // magnet range once; a timer would just re-collect at their feet.
  spawn(x: number, y: number, z: number, itemId: string = SHARD_ID, armed = true): void {
    const s = this.spawnSlot(x, y, z, itemId);
    if (s) s.armed = armed;
  }

  // Links the drop materials before an enemy dies; retires only this slot.
  warmUpDrop(x: number, y: number, z: number): void {
    this.warmSlot = this.spawnSlot(x, y, z, SHARD_ID);
  }

  retireWarmUpDrop(): void {
    if (!this.warmSlot) return;
    this.retire(this.warmSlot);
    this.warmSlot = null;
  }

  private warmSlot: Drop | null = null;

  private spawnSlot(x: number, y: number, z: number, itemId: string): Drop | null {
    const s = this.slot();
    if (!s) return null;
    const def = itemDef(itemId);
    s.active = true;
    s.grounded = false;
    s.claimed = false;
    s.armed = true;
    s.gen++;
    s.itemId = def.id;
    s.age = 0;
    s.seed = Math.random() * 100;
    const currency = def.kind === 'currency';
    s.mesh.geometry = currency ? this.shardGeo : this.cubeGeo;
    s.core.geometry = currency ? this.coreGeo : this.cubeCoreGeo;
    s.mat.color.setHex(def.color);
    s.glowMat.color.setHex(def.color);
    const a = Math.random() * Math.PI * 2;
    const h = 1.1 + Math.random() * 1.7;
    s.vel.set(Math.cos(a) * h, 3.4 + Math.random() * 1.9, Math.sin(a) * h);
    s.group.position.set(x, y, z);
    s.group.scale.setScalar(0.01);
    s.mat.opacity = 0.92;
    s.group.visible = true;
    return s;
  }

  /** Nearest unclaimed drop within `maxDist`; the caller claims it. */
  findJob(from: THREE.Vector3, maxDist: number, want: (itemId: string) => boolean): FetchJob | null {
    let best: Drop | null = null;
    let bd = maxDist * maxDist;
    for (const s of this.pool) {
      // Unarmed = just thrown away; fetching it back undoes what the player did.
      if (!s.active || s.claimed || !s.armed) continue;
      if (s.age < 0.5) continue;   // let it land, or a beast chases mid-air motes
      if (!want(s.itemId)) continue;
      // TRUE 3D distance (issue #78): horizontal-only sent beasts after motes
      // 80 units below a flying player.
      const dx = s.group.position.x - from.x;
      const dy = s.group.position.y - from.y;
      const dz = s.group.position.z - from.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best ? best.job : null;
  }

  snapshot(): { itemId: string; x: number; z: number; claimed: boolean; age: number }[] {
    const out = [];
    for (const s of this.pool) {
      if (!s.active) continue;
      out.push({
        itemId: s.itemId,
        x: +s.group.position.x.toFixed(2),
        z: +s.group.position.z.toFixed(2),
        claimed: s.claimed,
        age: +s.age.toFixed(1),
      });
    }
    return out;
  }

  private take(s: Drop, byBeast: boolean): void {
    const pos = s.group.position;
    const hex = itemDef(s.itemId).color;
    this.vfx.glowPulse(pos.x, pos.y, pos.z, hex, 1.7, 0.28);
    this.vfx.burst(pos.x, pos.y, pos.z, hex, 12, 3.4, 0.32, 0.22, 0, 0.4);
    this.vfx.flashLight(pos.x, pos.y, pos.z, hex, 2.6, 5, 0.2);
    this.retire(s);
    this.onCollect(s.itemId, byBeast);
  }

  private retire(s: Drop): void {
    s.active = false;
    s.claimed = false;
    s.gen++;
    s.group.visible = false;
  }

  // Retire everything uncollected (zone change). The `gen` bump in retire() is
  // what makes a FetchJob a beast still holds go inert rather than wrong.
  clear(): void {
    for (const s of this.pool) if (s.active) this.retire(s);
  }

  update(dt: number, magnet: THREE.Vector3, world: World): void {
    for (const s of this.pool) {
      if (!s.active) continue;
      s.age += dt;
      const pos = s.group.position;

      _v.set(magnet.x - pos.x, magnet.y + 0.8 - pos.y, magnet.z - pos.z);
      const d2 = _v.lengthSq();

      // Before the rules below: arming happens claimed, grounded or airborne.
      if (!s.armed && d2 > MAGNET_RANGE_SQ) s.armed = true;

      if (s.armed && !s.claimed && d2 < COLLECT_DIST_SQ && s.age > 0.3) {
        this.take(s, false);
        continue;
      }

      if (s.armed && !s.claimed && d2 < MAGNET_RANGE_SQ && s.age > 0.35) {
        const d = Math.sqrt(d2);
        _v.divideScalar(Math.max(0.001, d));
        const pull = 18 + (3 - Math.min(3, d)) * 26;
        s.vel.addScaledVector(_v, pull * dt);
        if (s.vel.lengthSq() > 196) s.vel.setLength(14);
        pos.addScaledVector(s.vel, dt);
        s.grounded = false;
        this.vfx.trail(pos.x, pos.y, pos.z, itemDef(s.itemId).color, 0.22);
      } else if (!s.grounded) {
        s.vel.y -= 11 * dt;
        pos.addScaledVector(s.vel, dt);
        const gy = world.getHeight(pos.x, pos.z) + 0.34;
        if (pos.y <= gy && s.vel.y <= 0) {
          pos.y = gy;
          s.grounded = true;
          s.vel.set(0, 0, 0);
          this.vfx.dust(pos.x, pos.y - 0.2, pos.z, 3, 0xbfeee6);
        }
      } else {
        const gy = world.getHeight(pos.x, pos.z) + 0.34;
        pos.y = gy + 0.06 + Math.sin(s.age * 3.4 + s.seed) * 0.09;
      }

      s.group.rotation.y = s.age * 3.4 + s.seed;
      s.glowMat.opacity = 0.52 + Math.sin(s.age * 5.2 + s.seed) * 0.2;

      const pop = Math.min(1, s.age / 0.16);
      s.group.scale.setScalar(0.2 + 0.8 * pop);
      if (s.age > MAX_AGE - 3) {
        const t = Math.max(0, (MAX_AGE - s.age) / 3);
        s.mat.opacity = 0.92 * t;
        s.glowMat.opacity *= t;
        if (s.age >= MAX_AGE) this.retire(s);
      }
    }
  }

  dispose(): void {
    for (const s of this.pool) {
      this.scene.remove(s.group);
      s.mat.dispose();
      s.coreMat.dispose();
      s.glowMat.dispose();
    }
    this.pool.length = 0;
    this.shardGeo.dispose();
    this.coreGeo.dispose();
    this.cubeGeo.dispose();
    this.cubeCoreGeo.dispose();
  }
}
