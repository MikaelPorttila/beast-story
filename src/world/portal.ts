/**
 * The thing you actually walk into: a stone arch over a lit pad.
 *
 * This is only the VISUAL and its own disposal. The rules that decide when
 * standing here means anything — the enter/exit radii, the dwell timer, the
 * preload band — live in zones.ts, because they are the same rules for every
 * gateway and none of them are about geometry.
 *
 * One of these is built per resident zone and disposed with it, so during the
 * preload band two exist at once. That matters for shader warm-up: the pad's
 * additive material and the shaft's are per-instance, so the destination's arch
 * is one of the things the warm-up sweep has to draw.
 */
import * as THREE from "three";

const PILLAR_H = 5.2;
const HALF_W = 2.3;

/** Stamp a constant vertex colour onto a geometry. See the material below. */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  const n = geo.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

export class Gateway {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private pad: THREE.Mesh;
  private shaft: THREE.Mesh;
  private padMat: THREE.MeshBasicMaterial;
  private shaftMat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(
    private scene: THREE.Scene,
    x: number,
    y: number,
    z: number,
    hex: number,
  ) {
    this.position.set(x, y, z);
    this.group.position.set(x, y, z);

    // `vertexColors` rather than a plain `color`, and the colour baked into the
    // geometry, because vertexColors is a program DEFINE: a plain-colour
    // standard material is a different program key from the terrain's, and one
    // gateway drawn in a zone warm-up sweep then linked ELEVEN new programs at
    // 121-206 ms of CPU each (measured, RTX 3070 Ti). Matching the terrain's
    // define set costs one buffer attribute and nothing else.
    const stone = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
    });
    const pillarGeo = paint(new THREE.BoxGeometry(0.9, PILLAR_H, 0.9), 0x7d7a86);
    const lintelGeo = paint(new THREE.BoxGeometry(HALF_W * 2 + 1.4, 0.95, 1.1), 0x8a8792);
    this.geos.push(pillarGeo, lintelGeo);
    this.mats.push(stone);
    for (const sx of [-HALF_W, HALF_W]) {
      const p = new THREE.Mesh(pillarGeo, stone);
      p.position.set(sx, PILLAR_H / 2, 0);
      p.castShadow = true;
      p.receiveShadow = true;
      this.group.add(p);
    }
    const lintel = new THREE.Mesh(lintelGeo, stone);
    lintel.position.set(0, PILLAR_H + 0.45, 0);
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    this.group.add(lintel);

    // The lit pad. Horizontal, so it reads from every approach — a flat plane
    // standing in the arch would vanish when you walk at it edge-on, and this
    // gateway has no front.
    const padGeo = new THREE.RingGeometry(1.05, 2.45, 32, 1);
    padGeo.rotateX(-Math.PI / 2);
    this.padMat = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.pad = new THREE.Mesh(padGeo, this.padMat);
    this.pad.position.y = 0.06;
    this.pad.renderOrder = 6;
    this.group.add(this.pad);

    // A soft shaft of light standing in the arch: an open-ended cylinder, so
    // there is something to see from a distance across a room.
    const shaftGeo = new THREE.CylinderGeometry(1.5, 1.9, PILLAR_H, 20, 1, true);
    this.shaftMat = new THREE.MeshBasicMaterial({
      color: hex,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.shaft = new THREE.Mesh(shaftGeo, this.shaftMat);
    this.shaft.position.y = PILLAR_H / 2;
    this.shaft.renderOrder = 5;
    this.group.add(this.shaft);

    this.geos.push(padGeo, shaftGeo);
    this.mats.push(this.padMat, this.shaftMat);
    scene.add(this.group);
  }

  /**
   * Breathe. `1 - exp(-lambda*dt)` is the house smoothing rule, but this is a
   * driven oscillation rather than a chase, so it integrates its own phase and
   * is frame-rate independent that way instead.
   */
  update(dt: number): void {
    this.t += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.9);
    // Kept LOW on purpose. These are additive and depth-write-free, and you
    // arrive standing on them: at the first pass (pad 0.55-0.90, shaft
    // 0.11-0.20) the camera spawns inside the shaft cylinder and the whole
    // frame washed to a flat warm yellow, taking the room's stonework with it.
    // The bloom pass already gives the pad a halo from much less than this.
    this.padMat.opacity = 0.24 + pulse * 0.18;
    this.shaftMat.opacity = 0.04 + pulse * 0.04;
    this.pad.rotation.y = this.t * 0.35;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const g of this.geos) {
      g.dispose();
    }
    for (const m of this.mats) {
      m.dispose();
    }
    this.geos.length = 0;
    this.mats.length = 0;
  }
}
