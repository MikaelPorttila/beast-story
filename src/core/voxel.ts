import * as THREE from 'three';

/**
 * Voxel model builder: paint voxels into a sparse grid, then bake a single
 * merged BufferGeometry containing only exterior faces, with per-vertex colors
 * and slight per-face shading for that chunky hand-lit Cube World look.
 *
 * Coordinates are integer voxel cells. One cell = `scale` world units.
 */
export class VoxelModel {
  private cells = new Map<string, number>(); // key "x,y,z" -> color hex
  private emissiveCells = new Map<string, number>(); // key "x,y,z" -> intensity
  private emissiveColors = new Map<number, number>(); // color hex -> intensity

  set(x: number, y: number, z: number, color: number): void {
    this.cells.set(`${x},${y},${z}`, color);
  }

  /** Paint a voxel and flag it emissive (glows with its own color). */
  setEmissive(x: number, y: number, z: number, color: number, intensity = 1.5): void {
    this.set(x, y, z, color);
    this.emissiveCells.set(`${x},${y},${z}`, intensity);
  }

  /** Flag every voxel painted with `colorHex` as emissive at `intensity`. */
  markEmissive(colorHex: number, intensity = 1.5): void {
    this.emissiveColors.set(colorHex, intensity);
  }

  /** Fill an inclusive box */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
          this.set(x, y, z, color);
  }

  /** Filled ellipsoid centered at (cx,cy,cz) with radii (rx,ry,rz) */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: number): void {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1.0) this.set(x, y, z, color);
        }
  }

  /** Mirror all cells across x → adds mirrored copies (for symmetric bodies) */
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

  /**
   * Bake to a mesh. Origin: x/z centered if center=true; y=0 at the lowest voxel.
   * Faces get subtle directional shade baked into vertex colors so models read
   * as chunky even under flat lighting.
   */
  build(scale = 0.1, center = true): THREE.Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const key of this.cells.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = center ? (minX + maxX + 1) / 2 : 0;
    const cz = center ? (minZ + maxZ + 1) / 2 : 0;
    const cy = minY;

    // face: [normal, 4 corners]
    const FACES: Array<{ n: [number, number, number]; c: number[][]; shade: number }> = [
      { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.88 },
      { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.88 },
      { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], shade: 1.0 },
      { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.62 },
      { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.8 },
      { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.8 },
    ];

    // Base (lit) faces go into the arrays declared above; emissive voxels are
    // batched per (color, intensity) so each batch gets its own glow material.
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
        if (this.has(x + nx, y + ny, z + nz)) continue; // occluded
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

    // Emissive voxels ride along as child meshes so callers still get one Mesh.
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

/** Convenience: darken/lighten a hex color */
export function shade(hex: number, mul: number): number {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  return c.getHex();
}
