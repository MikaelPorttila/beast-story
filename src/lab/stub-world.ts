import * as THREE from 'three';
import type { World } from '../core/types';

/**
 * Minimal World implementation for the lab: a flat (optionally water-filled)
 * stage with no chunk streaming, no props and no shops. Everything that takes
 * a World — pals, enemies, combat — runs against this unchanged, so behaviour
 * matches the real game minus the terrain itself.
 */
export class StubWorld implements World {
  /** Bare stage: the flat floor is the only thing to hold onto. */
  climbTopAt(): number { return this.getHeight(); }
  /** No props on the stage, so there is never a trunk in the way. */
  trunkSolidTopAt(): number { return -Infinity; }

  readonly waterLevel: number;
  readonly shopPositions: THREE.Vector3[] = [];
  readonly spawnPoint = new THREE.Vector3(0, 0, 0);
  private disposables: Array<{ dispose(): void }> = [];

  /**
   * @param scene    stage scene
   * @param groundY  height of the flat floor
   * @param flooded  when true the floor sits below water level (swim testing)
   */
  constructor(scene: THREE.Scene, private groundY = 0, flooded = false) {
    this.waterLevel = flooded ? groundY + 1.6 : groundY - 50;
    this.spawnPoint.set(0, groundY, 0);

    // Checkerboard floor: neutral value, reads scale without stealing focus.
    const size = 64;
    const geo = new THREE.PlaneGeometry(size, size, size, size);
    geo.rotateX(-Math.PI / 2);
    const colors: number[] = [];
    const pos = geo.getAttribute('position');
    const a = new THREE.Color(0x8fa87f);
    const b = new THREE.Color(0x84a074);
    for (let i = 0; i < pos.count; i++) {
      const cx = Math.floor(pos.getX(i) + size / 2);
      const cz = Math.floor(pos.getZ(i) + size / 2);
      const c = (cx + cz) % 2 === 0 ? a : b;
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const floor = new THREE.Mesh(geo, mat);
    floor.position.y = groundY;
    floor.receiveShadow = true;
    scene.add(floor);
    this.disposables.push(geo, mat);

    if (flooded) {
      const wgeo = new THREE.PlaneGeometry(size, size);
      wgeo.rotateX(-Math.PI / 2);
      const wmat = new THREE.MeshStandardMaterial({
        color: 0x3fa7f5, transparent: true, opacity: 0.62, roughness: 0.25,
      });
      const water = new THREE.Mesh(wgeo, wmat);
      water.position.y = this.waterLevel;
      scene.add(water);
      this.disposables.push(wgeo, wmat);
    }
  }

  getHeight(): number {
    return this.groundY;
  }

  isWater(): boolean {
    return this.waterLevel > this.groundY;
  }

  update(): void {
    /* nothing streams in the lab */
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
