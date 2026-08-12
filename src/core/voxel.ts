import * as THREE from 'three';

/** The cells one bracketed loop painted. See `VoxelModel.region`. */
export interface VoxelRegion {
  has(x: number, y: number, z: number): boolean;
  readonly size: number;
}

/** Sparse voxel grid baked to one merged geometry. One cell = `scale` world units. */
export class VoxelModel {
  private cells = new Map<string, number>(); // "x,y,z" -> color hex
  private emissiveCells = new Map<string, number>(); // "x,y,z" -> intensity
  private emissiveColors = new Map<number, number>(); // color hex -> intensity
  private recording: Set<string> | null = null;

  set(x: number, y: number, z: number, color: number): void {
    const key = `${x},${y},${z}`;
    this.cells.set(key, color);
    this.recording?.add(key);
  }

  /** Hands back the cells `paint` painted, so a builder can BRACKET a part
   * (a roof) that no rule over the finished grid could separate. */
  region(paint: () => void): VoxelRegion {
    const outer = this.recording;
    const own = new Set<string>();
    this.recording = own;
    try {
      paint();
    } finally {
      this.recording = outer;
      // A nested region belongs to its parent too.
      if (outer) for (const k of own) outer.add(k);
    }
    return { has: (x, y, z) => own.has(`${x},${y},${z}`), size: own.size };
  }

  setEmissive(x: number, y: number, z: number, color: number, intensity = 1.5): void {
    this.set(x, y, z, color);
    this.emissiveCells.set(`${x},${y},${z}`, intensity);
  }

  markEmissive(colorHex: number, intensity = 1.5): void {
    this.emissiveColors.set(colorHex, intensity);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
          this.set(x, y, z, color);
  }

  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: number): void {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1.0) this.set(x, y, z, color);
        }
  }

  /** Adds mirrored copies; originals stay. */
  mirrorX(): void {
    const entries = [...this.cells.entries()];
    for (const [key, color] of entries) {
      const [x, y, z] = key.split(',').map(Number);
      this.set(-x, y, z, color);
    }
  }

  has(x: number, y: number, z: number): boolean {
    return this.cells.has(`${x},${y},${z}`);
  }

  /** Cell coordinates, so a collider is MEASURED off the mesh's own cells
   * (`measureFootprint`, world/structures.ts). */
  forEachCell(fn: (x: number, y: number, z: number) => void): void {
    for (const key of this.cells.keys()) {
      const c = key.split(',');
      fn(+c[0], +c[1], +c[2]);
    }
  }

  /** Bounds plus the ORIGIN `build` re-bases on. Never recompute `ox`/`oy`/`oz`
   * elsewhere — a second copy drifts half a voxel off the mesh. */
  bounds(center = true): {
    minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
    ox: number; oy: number; oz: number;
  } {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const key of this.cells.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      ox: center ? (minX + maxX + 1) / 2 : 0,
      oz: center ? (minZ + maxZ + 1) / 2 : 0,
      oy: minY,
    };
  }

  /** Bake to a mesh. Directional shade is baked into vertex colors. */
  build(scale = 0.1, center = true): THREE.Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const b = this.bounds(center);
    const cx = b.ox;
    const cz = b.oz;
    const cy = b.oy;

    const FACES: Array<{ n: [number, number, number]; c: number[][]; shade: number }> = [
      { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.88 },
      { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.88 },
      { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], shade: 1.0 },
      { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.62 },
      { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.8 },
      { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.8 },
    ];

    // Emissive voxels batch per (color, intensity): one glow material each.
    interface EmissiveBatch {
      hex: number;
      intensity: number;
      positions: number[];
      normals: number[];
      colors: number[];
      indices: number[];
    }
    const emissiveBatches = new Map<string, EmissiveBatch>();

    const color = new THREE.Color();
    for (const [key, hex] of this.cells.entries()) {
      const [x, y, z] = key.split(',').map(Number);
      const intensity = this.emissiveCells.get(key) ?? this.emissiveColors.get(hex);
      let pos = positions, nor = normals, col = colors, idx = indices;
      let shadeMul = 1;
      if (intensity !== undefined) {
        const bk = `${hex}:${intensity}`;
        let batch = emissiveBatches.get(bk);
        if (!batch) {
          batch = { hex, intensity, positions: [], normals: [], colors: [], indices: [] };
          emissiveBatches.set(bk, batch);
        }
        pos = batch.positions; nor = batch.normals; col = batch.colors; idx = batch.indices;
        shadeMul = 0.45; // darkened diffuse so the emissive term dominates
      }
      for (const face of FACES) {
        const [nx, ny, nz] = face.n;
        if (this.has(x + nx, y + ny, z + nz)) continue;
        const base = pos.length / 3;
        color.setHex(hex).multiplyScalar(face.shade * shadeMul);
        for (const [ox, oy, oz] of face.c) {
          pos.push((x + ox - cx) * scale, (y + oy - cy) * scale, (z + oz - cz) * scale);
          nor.push(nx, ny, nz);
          col.push(color.r, color.g, color.b);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    const mkGeo = (p: number[], n: number[], c: number[], i: number[]): THREE.BufferGeometry => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      geo.setIndex(i);
      if (p.length > 0) geo.computeBoundingSphere();
      else geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
      return geo;
    };

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(mkGeo(positions, normals, colors, indices), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (const batch of emissiveBatches.values()) {
      const emMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.0,
        emissive: new THREE.Color(batch.hex),
        emissiveIntensity: batch.intensity,
      });
      const emMesh = new THREE.Mesh(
        mkGeo(batch.positions, batch.normals, batch.colors, batch.indices),
        emMat,
      );
      emMesh.castShadow = false;
      emMesh.receiveShadow = false;
      mesh.add(emMesh);
    }
    return mesh;
  }
}

export function shade(hex: number, mul: number): number {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  return c.getHex();
}
