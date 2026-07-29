import * as THREE from 'three';
import type { World } from '../core/types';
import type { VFX } from './vfx';

/**
 * Shard pickups: glowing spinning crystal shards dropped by defeated enemies.
 * They pop out with a little arc, settle to the ground and bob, then magnet
 * to the player when within range. Pooled — no per-frame allocations.
 */

const SHARD_HEX = 0x76eee0;
const CORE_HEX = 0xeafffb;
const MAGNET_RANGE_SQ = 9;      // 3 units
const COLLECT_DIST_SQ = 0.45;
const MAX_AGE = 42;

const _v = new THREE.Vector3();

interface Shard {
  active: boolean;
  group: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  glowMat: THREE.SpriteMaterial;
  vel: THREE.Vector3;
  age: number;
  seed: number;
  grounded: boolean;
}

export class Pickups {
  private pool: Shard[] = [];
  private shardGeo: THREE.OctahedronGeometry;
  private coreGeo: THREE.OctahedronGeometry;

  constructor(
    private scene: THREE.Scene,
    private vfx: VFX,
    private onCollect: () => void,
  ) {
    this.shardGeo = new THREE.OctahedronGeometry(0.16, 0);
    this.shardGeo.scale(1, 1.65, 1);
    this.coreGeo = new THREE.OctahedronGeometry(0.085, 0);
    this.coreGeo.scale(1, 1.65, 1);
  }

  private slot(): Shard | null {
    for (const s of this.pool) if (!s.active) return s;
    if (this.pool.length >= 48) return null;
    const mat = new THREE.MeshBasicMaterial({
      color: SHARD_HEX, transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: CORE_HEX, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const glowMat = new THREE.SpriteMaterial({
      map: this.vfx.glowTexture, color: SHARD_HEX, transparent: true, opacity: 0.7,
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
    const s: Shard = {
      active: false, group, mat, glowMat,
      vel: new THREE.Vector3(), age: 0, seed: 0, grounded: false,
    };
    this.pool.push(s);
    return s;
  }

  /** Launch a shard from a death point with a small celebratory arc. */
  spawn(x: number, y: number, z: number): void {
    const s = this.slot();
    if (!s) return;
    s.active = true;
    s.grounded = false;
    s.age = 0;
    s.seed = Math.random() * 100;
    const a = Math.random() * Math.PI * 2;
    const h = 1.1 + Math.random() * 1.7;
    s.vel.set(Math.cos(a) * h, 3.4 + Math.random() * 1.9, Math.sin(a) * h);
    s.group.position.set(x, y, z);
    s.group.scale.setScalar(0.01);
    s.mat.opacity = 0.92;
    s.group.visible = true;
  }

  update(dt: number, magnet: THREE.Vector3, world: World): void {
    for (const s of this.pool) {
      if (!s.active) continue;
      s.age += dt;
      const pos = s.group.position;

      _v.set(magnet.x - pos.x, magnet.y + 0.8 - pos.y, magnet.z - pos.z);
      const d2 = _v.lengthSq();

      if (d2 < COLLECT_DIST_SQ && s.age > 0.3) {
        this.vfx.glowPulse(pos.x, pos.y, pos.z, SHARD_HEX, 1.7, 0.28);
        this.vfx.burst(pos.x, pos.y, pos.z, SHARD_HEX, 12, 3.4, 0.32, 0.22, 0, 0.4);
        this.vfx.flashLight(pos.x, pos.y, pos.z, SHARD_HEX, 2.6, 5, 0.2);
        s.active = false;
        s.group.visible = false;
        this.onCollect();
        continue;
      }

      if (d2 < MAGNET_RANGE_SQ && s.age > 0.35) {
        // fly to the player, gravity off
        const d = Math.sqrt(d2);
        _v.divideScalar(Math.max(0.001, d));
        const pull = 18 + (3 - Math.min(3, d)) * 26;
        s.vel.addScaledVector(_v, pull * dt);
        if (s.vel.lengthSq() > 196) s.vel.setLength(14);
        pos.addScaledVector(s.vel, dt);
        s.grounded = false;
        this.vfx.trail(pos.x, pos.y, pos.z, SHARD_HEX, 0.22);
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

      // spin + sparkle
      s.group.rotation.y = s.age * 3.4 + s.seed;
      s.glowMat.opacity = 0.52 + Math.sin(s.age * 5.2 + s.seed) * 0.2;

      // pop-in scale, fade-out near despawn
      const pop = Math.min(1, s.age / 0.16);
      s.group.scale.setScalar(0.2 + 0.8 * pop);
      if (s.age > MAX_AGE - 3) {
        const t = Math.max(0, (MAX_AGE - s.age) / 3);
        s.mat.opacity = 0.92 * t;
        s.glowMat.opacity *= t;
        if (s.age >= MAX_AGE) {
          s.active = false;
          s.group.visible = false;
        }
      }
    }
  }
}
