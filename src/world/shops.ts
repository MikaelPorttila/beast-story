/**
 * Skill Dens — charming pagoda-tent shops with element-colored roofs,
 * hanging banners, a glowing crystal finial with orbiting sparks, a soft
 * point light and a gently bobbing floating icon.
 *
 * They are SOLID, by the same primitive and the same measurement a hut is (see
 * world/structures.ts). They were scenery until this note existed — the hero
 * walked in one side of the pagoda and out the other, through the back wall,
 * the counter and the shelf of potion bottles — which is exactly what a town
 * was before `structureTopAt` and is the last building in the game that was
 * still drawn without being stamped.
 *
 * Nothing here authors a collider. `measureFootprint` reads the voxel model the
 * builder just painted, so a den's boxes are its walls by construction and
 * cannot drift when someone resizes the deck.
 */
import * as THREE from "three";
import { VoxelModel, shade } from "../core/voxel";
import { ELEMENT_COLORS, type ElementType } from "../core/types";
import { relight, type SolidBox } from "./props";
import { measureFootprint, StructureField } from "./structures";
import { installRingFade, type RingBand } from "./distant-terrain";
import { smoothstep } from "./terrain";

const DEN_ELEMENTS: ElementType[] = ["fire", "water", "grass", "electric"];

export interface DenSpot {
  x: number;
  z: number;
  h: number;
}

interface DenAnim {
  den: THREE.Group;
  crystalPivot: THREE.Group;
  crystal: THREE.Mesh;
  orbiters: THREE.Mesh[];
  halo: THREE.Sprite;
  icon: THREE.Sprite;
  iconBaseY: number;
  light: THREE.PointLight;
  phase: number;
}

const glowTexCache = new Map<number, THREE.Texture>();

function glowTexture(hex: number): THREE.Texture {
  const cached = glowTexCache.get(hex);
  if (cached) {
    return cached;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = new THREE.Color(hex);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.6, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowTexCache.set(hex, tex);
  return tex;
}

const glyphTexCache = new Map<string, THREE.Texture>();

/**
 * Element glyph for the floating shop icon: a simple filled shape (flame /
 * droplet / leaf / bolt) in the element color with a thin white outline on a
 * transparent 64px canvas — a readable sign, not a bloom orb.
 */
function glyphTexture(el: ElementType, hex: number): THREE.Texture {
  const cached = glyphTexCache.get(el);
  if (cached) {
    return cached;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = new THREE.Color(hex);
  ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (el) {
    case "fire":
      // flame: teardrop body with a licking tip
      ctx.moveTo(32, 5);
      ctx.bezierCurveTo(30, 16, 44, 20, 47, 33);
      ctx.bezierCurveTo(50, 46, 42, 57, 32, 57);
      ctx.bezierCurveTo(22, 57, 14, 47, 16, 35);
      ctx.bezierCurveTo(17, 27, 23, 24, 24, 17);
      ctx.bezierCurveTo(28, 21, 30, 14, 32, 5);
      break;
    case "water":
      // droplet
      ctx.moveTo(32, 5);
      ctx.bezierCurveTo(42, 22, 50, 30, 50, 40);
      ctx.bezierCurveTo(50, 50, 42, 58, 32, 58);
      ctx.bezierCurveTo(22, 58, 14, 50, 14, 40);
      ctx.bezierCurveTo(14, 30, 22, 22, 32, 5);
      break;
    case "grass":
      // leaf with a pointed tip
      ctx.moveTo(32, 6);
      ctx.quadraticCurveTo(54, 18, 50, 40);
      ctx.quadraticCurveTo(47, 55, 32, 58);
      ctx.quadraticCurveTo(13, 51, 14, 30);
      ctx.quadraticCurveTo(15, 14, 32, 6);
      break;
    case "electric":
      // zigzag bolt
      ctx.moveTo(38, 4);
      ctx.lineTo(16, 36);
      ctx.lineTo(29, 36);
      ctx.lineTo(24, 60);
      ctx.lineTo(48, 26);
      ctx.lineTo(34, 26);
      break;
    default:
      // fallback: diamond
      ctx.moveTo(32, 6);
      ctx.lineTo(54, 32);
      ctx.lineTo(32, 58);
      ctx.lineTo(10, 32);
      break;
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glyphTexCache.set(el, tex);
  return tex;
}

/** Pull a hex color toward grey by `amount` (0..1) without shifting hue/lightness. */
function desaturate(hex: number, amount: number): number {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * (1 - amount), hsl.l);
  return c.getHex();
}

const V = 0.15; // voxel scale of the buildings

// One shared wood-trim palette across every shop — element identity lives in
// the crystal, banners and roof tint only, so the row reads as one village.
const TRIM_PLANK = 0x9d7346;
const TRIM_PLANK_DARK = shade(TRIM_PLANK, 0.82);
const TRIM_WOOD_DARK = 0x67462a;
const TRIM_CREAM = 0xf0e4c8;

export class Shops {
  readonly group = new THREE.Group();
  readonly positions: THREE.Vector3[] = [];
  /**
   * What the dens block, in world space — the third `StructureField` beside the
   * settlements' and the people's, and its own for the same reason theirs are
   * separate: a field is frozen by `build()` at the end of its owner's
   * constructor, and the dens are placed before `Towns` exists. `createWorld`
   * takes the max of the three (see `structureTop` in world/index.ts), which is
   * what `blockTop` already does with terrain and trunks.
   */
  readonly solids = new StructureField();
  private readonly anims: DenAnim[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(
    spots: readonly DenSpot[],
    spawn: THREE.Vector3,
    /** The detailed ring: a den dies on it like the huts and trees around it. */
    private readonly ring: RingBand,
  ) {
    spots.forEach((s, i) => {
      const el = DEN_ELEMENTS[i % DEN_ELEMENTS.length];
      const built = this.buildDen(el, i);
      // The den faces spawn, so its OPEN front — the counter, between the two
      // banners — is the side a player walks up from.
      const yaw = Math.atan2(spawn.x - s.x, spawn.z - s.z);
      built.den.position.set(s.x, s.h, s.z);
      built.den.rotation.y = yaw;
      this.group.add(built.den);
      this.positions.push(new THREE.Vector3(s.x, s.h, s.z));
      // The same call shape `SolidStamp.add` uses, at the pose the mesh was
      // placed in — `StructureField.add` applies the yaw exactly as three's
      // `rotation.y` does, so the boxes turn with the pagoda for free.
      this.solids.add({ solid: built.solid }, s.x, s.h, s.z, yaw, 1, 1);
    });
    this.solids.build();
  }

  private buildDen(el: ElementType, index: number): { den: THREE.Group; solid: SolidBox[] } {
    const den = new THREE.Group();
    const elHex = ELEMENT_COLORS[el];
    // roofs at ~18% lower saturation: tinted, not food-court neon
    const roofHex = desaturate(elHex, 0.18);
    const roofC = shade(roofHex, 0.92);
    const roofDark = shade(roofHex, 0.68);
    const roofLight = shade(roofHex, 1.15);
    const plank = TRIM_PLANK;
    const plankDark = TRIM_PLANK_DARK;
    const woodDark = TRIM_WOOD_DARK;
    const cream = TRIM_CREAM;

    const v = new VoxelModel();

    // deck with alternating plank stripes
    for (let x = -12; x <= 12; x++) {
      for (let z = -12; z <= 12; z++) {
        const pc = ((x + 120) >> 1) % 2 === 0 ? plank : plankDark;
        v.set(x, 0, z, shade(pc, 0.85));
        v.set(x, 1, z, pc);
      }
    }
    // corner posts
    v.box(-11, 2, -11, -10, 12, -10, woodDark);
    v.box(10, 2, -11, 11, 12, -10, woodDark);
    v.box(-11, 2, 10, -10, 12, 11, woodDark);
    v.box(10, 2, 10, 11, 12, 11, woodDark);
    // back wall + beams
    v.box(-10, 2, -11, 10, 12, -10, cream);
    for (const bx of [-10, -5, 0, 5, 10]) {
      v.box(bx, 2, -10, bx, 12, -10, woodDark);
    }
    v.box(-10, 12, -10, 10, 12, -10, woodDark);
    // half side walls
    v.box(-11, 2, -10, -10, 10, -3, cream);
    v.box(10, 2, -10, 11, 10, -3, cream);
    v.box(-11, 10, -10, -10, 10, -3, woodDark);
    v.box(10, 10, -10, 11, 10, -3, woodDark);
    // shop counter
    v.box(-7, 2, 7, 7, 4, 9, plank);
    v.box(-7, 5, 6, 7, 5, 10, shade(plank, 1.18));
    // shelf with potion bottles
    v.box(-8, 7, -9, 8, 7, -9, woodDark);
    const bottleColors = [0xff6b35, 0x3fa7f5, 0x6dbf4b, 0xffd23f, 0xe05580];
    for (let bi = 0; bi < 5; bi++) {
      const bx = -6 + bi * 3;
      const bc = bottleColors[(bi + index) % bottleColors.length];
      v.box(bx, 8, -9, bx, 9, -9, bc);
      v.set(bx, 10, -9, 0xd8d2c2);
    }
    // pagoda roof — three element-tinted tiers with corner upturns
    //
    // BRACKETED, and the bracket is what keeps the shop a shop. The lowest
    // course sits 1.95 units over the deck, a hair under `WALK_UNDER`'s 2.0, so
    // measured as part of the body band the eaves are a lid: every column of the
    // den is under one, the flood fill joins the whole model into a single
    // 4.35-unit box, and the open front the player buys through becomes a wall.
    // A roof is the line where a building stops being a wall — see
    // `measureFootprint` — so nothing from here up is measured.
    const roof = v.region(() => {
      v.box(-14, 13, -14, 14, 14, 14, roofDark);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          v.box(sx * 13, 15, sz * 13, sx * 14, 15, sz * 14, roofDark);
        }
      }
      v.box(-8, 15, -8, 8, 15, 8, cream);
      v.box(-9, 16, -9, 9, 17, 9, roofC);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          v.box(sx * 9, 18, sz * 9, sx * 9, 18, sz * 9, roofC);
        }
      }
      v.box(-4, 18, -4, 4, 18, 4, cream);
      v.box(-5, 19, -5, 5, 20, 5, roofLight);
      v.box(-2, 21, -2, 2, 22, 2, roofLight);
      v.set(0, 23, 0, 0xffe9a0);
    });
    // hanging banners flanking the entrance
    for (const sx of [-1, 1]) {
      const bx = sx * 10;
      v.box(bx, 4, 13, bx, 12, 13, elHex);
      v.box(bx, 11, 13, bx, 12, 13, 0xf6f2e2);
      v.set(bx, 8, 13, 0xffffff);
      v.box(bx, 13, 12, bx, 13, 14, woodDark);
    }

    // The footprint, measured off the finished model — one box per lump of den a
    // body walks into: the back-and-sides shell with its shelf, the two front
    // corner posts, the counter, and a banner apiece.
    //
    // NO RIDGE CYLINDER goes with it, and that is a statement about the shape
    // rather than an omission. `measureRidge` fits a cylinder lying along a
    // CREST, which a gable and a ridge tent are; a pagoda is a square stepped
    // pyramid whose crest is a single finial voxel, so the best circle through
    // it is a poor answer to a question nobody asks — the eaves are 1.95 units
    // up, the roof is not walkable and there is nothing here to stand on it
    // from. The walls are what stops you, and the walls are boxes.
    const solid = measureFootprint(v, V, [roof]);

    const buildingMesh = v.build(V, true);
    // Undo VoxelModel's baked fake-sun face table — see `relight` in props.ts for
    // the full argument. It matters more here than anywhere: a pagoda is mostly
    // INTERIOR, and its side walls, shelf slots and counter faces are all
    // vertical surfaces the sun never reaches, so the baked 0.80/0.88 multipliers
    // landed on top of hemisphere-only light and turned the window openings and the
    // seam under the deck into pure black holes. The critic read the whole shrine
    // as "burnt-out rather than shaded", which is exactly right.
    {
      const g = buildingMesh.geometry;
      relight(
        (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
        (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
      );
    }
    den.add(buildingMesh);
    this.disposables.push(buildingMesh.geometry, buildingMesh.material as THREE.Material);

    // -- glowing crystal + orbiting sparks ----------------------------------
    const crystalPivot = new THREE.Group();
    crystalPivot.position.set(0, 24 * V + 0.55, 0);
    den.add(crystalPivot);

    const crystalMat = new THREE.MeshStandardMaterial({
      color: shade(elHex, 1.15),
      emissive: elHex,
      emissiveIntensity: 1.6,
      roughness: 0.25,
      metalness: 0.1,
    });
    const crystalGeo = new THREE.OctahedronGeometry(0.38, 0);
    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    crystal.castShadow = true;
    crystalPivot.add(crystal);
    this.disposables.push(crystalGeo, crystalMat);

    const orbGeo = new THREE.OctahedronGeometry(0.09, 0);
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: elHex,
      emissiveIntensity: 2.2,
      roughness: 0.4,
    });
    this.disposables.push(orbGeo, orbMat);
    const orbiters: THREE.Mesh[] = [];
    for (let k = 0; k < 3; k++) {
      const orb = new THREE.Mesh(orbGeo, orbMat);
      crystalPivot.add(orb);
      orbiters.push(orb);
    }

    // subtle halo glow around the crystal — kept small and dim so the finial
    // reads as a lit gem, not a supernova washing out the roof
    const haloMat = new THREE.SpriteMaterial({
      map: glowTexture(elHex),
      color: elHex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.35,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(1.1);
    crystalPivot.add(halo);
    this.disposables.push(haloMat);

    // floating element glyph above the den (crisp sign, not a glow orb)
    const iconMat = new THREE.SpriteMaterial({
      map: glyphTexture(el, elHex),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      opacity: 1.0,
    });
    const icon = new THREE.Sprite(iconMat);
    const iconBaseY = crystalPivot.position.y + 1.25;
    icon.position.set(0, iconBaseY, 0);
    icon.scale.setScalar(0.7);
    den.add(icon);
    this.disposables.push(iconMat);

    // warm element light spilling over the counter (distance-limited for perf)
    const light = new THREE.PointLight(elHex, 6, 18, 2);
    light.position.set(0, 2.3, 0.8);
    light.castShadow = false;
    den.add(light);

    // Every mesh material dies on the detailed ring; `build` mints per-mesh
    // materials, so this cannot leak onto another model's. The sprites and the
    // light have no fragment alpha to fade — `update` walks them down instead.
    den.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        installRingFade(o.material as THREE.Material, this.ring);
      }
    });

    this.anims.push({
      den,
      crystalPivot,
      crystal,
      orbiters,
      halo,
      icon,
      iconBaseY,
      light,
      phase: index * 1.71,
    });
    return { den, solid };
  }

  update(time: number, focus: Readonly<THREE.Vector3>): void {
    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];
      // The sprite/light half of the ring fade the mesh materials carry in
      // their shader — and past the ring the whole den skips its frame work.
      const p = this.positions[i];
      const fade = 1 - smoothstep(this.ring.start.value, this.ring.end.value, p.distanceTo(focus));
      a.den.visible = fade > 0;
      if (!a.den.visible) {
        continue;
      }
      (a.halo.material as THREE.SpriteMaterial).opacity = 0.35 * fade;
      (a.icon.material as THREE.SpriteMaterial).opacity = fade;
      const t = time + a.phase;
      a.crystal.position.y = Math.sin(t * 1.5) * 0.14;
      a.crystal.rotation.y = t * 0.8;
      for (let k = 0; k < a.orbiters.length; k++) {
        const ang = t * 1.4 + k * ((Math.PI * 2) / 3);
        a.orbiters[k].position.set(
          Math.cos(ang) * 0.85,
          Math.sin(t * 2 + k * 1.3) * 0.22,
          Math.sin(ang) * 0.85,
        );
        a.orbiters[k].rotation.y = t * 3 + k;
      }
      a.icon.position.y = a.iconBaseY + Math.sin(t * 1.1) * 0.18;
      a.light.intensity = (6 + Math.sin(t * 2.3) * 0.8) * fade;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.anims.length = 0;
  }
}
