/**
 * DEBUG-SPAWNED STRUCTURES — the one place in the game where a building appears
 * after world creation.
 *
 * Everything else built out of `world/structures.ts` is stamped once, at boot,
 * by a town layout: `Towns` fills a `StructureField`, calls `build()` on it, and
 * from there the field is read-only for the life of the session. That is right
 * for a settlement — towns do not stream — and it is exactly what makes "put a
 * hut in front of me and see how it reads against the terrain" impossible from
 * a running game.
 *
 * So this is a SECOND field and a second mesh, owned by nothing content-facing,
 * and the F3 Debug panel's spawner is its only writer. It obeys the same rule
 * the town builders do and for the same reason: one call stamps the mesh and
 * the collider (see `SolidStamp`), so a piece dropped here is a piece you can
 * walk into. A debug spawner that drew a wall you could stroll through would be
 * worse than no spawner — it would teach you the wrong thing about the wall.
 *
 * REBUILT WHOLE ON EVERY SPAWN, which sounds wasteful and is not. `StructureField`
 * already re-indexes from its own `data` array whenever a stamp arrives after a
 * `build()`, and the mesh is one merged geometry over a handful of parts a
 * person clicked by hand. The alternative — an incremental merge — would be a
 * second code path through the accumulator to save microseconds nobody is
 * measuring on a frame nobody is profiling.
 */
import * as THREE from "three";
import { Accum, type PropLib, type Template } from "./props";
import { SolidStamp, StructureField } from "./structures";
import { TownParts } from "./town-parts";

/** One stamped piece, kept so the mesh can be rebuilt from scratch. */
interface Placed {
  t: Template;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * How many parts may stand at once.
 *
 * A CAP RATHER THAN A LEAK. Every spawn rebuilds the merged geometry and
 * re-indexes the collider field, both of which are linear in what is standing —
 * so an unbounded list turns a debug convenience into a frame-time cliff about
 * two hundred clicks in. The oldest goes when the cap is reached, which is the
 * behaviour a person clicking around actually wants: the thing you just placed
 * is the thing you are looking at.
 */
const MAX_PLACED = 96;

export class SpawnedSolids {
  readonly group = new THREE.Group();
  private placed: Placed[] = [];
  private field = new StructureField();
  private mesh: THREE.Mesh | null = null;
  /**
   * The part library, built on the FIRST spawn and never at boot.
   *
   * `TownParts` bakes twenty-six voxel models, and a world with `towns=0` in it
   * does not build one at all. Paying for that in every session so that a panel
   * nobody opened could have been fast would be the wrong trade — a debug
   * feature earns its cost when it is used.
   */
  private parts: TownParts | null = null;
  private catalogue: Map<string, Template> | null = null;

  constructor(
    private readonly lib: PropLib,
    private readonly getHeight: (x: number, z: number) => number,
  ) {}

  /**
   * What can be stamped, by name.
   *
   * TOWN PARTS ONLY, and the omission is deliberate: every piece here comes off
   * `bakeSolid`, so every one of them carries the footprint its own voxels were
   * measured into. Trees and rocks come off `bakeProp` and carry no footprint
   * at all — a rock spawned here would be a picture of a rock with nothing
   * behind it, and the trees already answer to `/nature`.
   *
   * The four `*Glow` pieces are left out too. They are the emissive HALF of a
   * fire or a lamp and want the town's glow material, not the solid one; the
   * bodies they belong to are here and are what you actually place.
   *
   * SO IS THE FENCE KIT, for a third reason: a fence is a CHAIN, planned post to
   * post by world/fences.ts, and only its planks are solid at all (the stakes
   * are `bakeProp` — see `fencePost`). One stake dropped on the ground would be
   * neither a fence nor an obstacle. If the spawner ever wants fences it wants
   * `planFences`, not a part out of the kit.
   */
  names(): readonly string[] {
    return [...this.parts_().keys()];
  }

  get count(): number {
    return this.placed.length;
  }

  /**
   * Stamp one part standing on the ground at (x, z).
   *
   * The height is sampled rather than passed in because the caller — a panel
   * row — knows where the hero is and nothing about terrain; and it is the
   * TERRAIN height, so a piece dropped on a roof lands on the ground under it.
   * That is the honest answer for a thing whose collider is measured from its
   * own base.
   */
  spawn(name: string, x: number, z: number, yaw: number): boolean {
    const t = this.parts_().get(name);
    if (!t) {
      return false;
    }
    this.placed.push({ t, x, y: this.getHeight(x, z), z, yaw });
    if (this.placed.length > MAX_PLACED) {
      this.placed.shift();
    }
    this.rebuild();
    return true;
  }

  /** Take everything back down. The panel's Clear row and `exitToTitle`. */
  clear(): void {
    if (this.placed.length === 0) {
      return;
    }
    this.placed.length = 0;
    this.rebuild();
  }

  /** Top of anything spawned over this column, or -Infinity. See StructureField. */
  topAt(x: number, z: number): number {
    return this.field.topAt(x, z);
  }

  debugBoxes(out: number[]): void {
    this.field.debugBoxes(out);
  }
  debugRidges(out: number[]): void {
    this.field.debugRidges(out);
  }

  dispose(): void {
    this.dropMesh();
    this.group.removeFromParent();
  }

  private parts_(): Map<string, Template> {
    if (this.catalogue) {
      return this.catalogue;
    }
    const p = this.parts ?? (this.parts = new TownParts());
    // Ordered from the biggest thing you can stand a camp on down to the
    // smallest thing you can drop beside a road, so the tree reads top to
    // bottom the way a settlement is actually assembled.
    this.catalogue = new Map<string, Template>([
      ["palisade", p.palisade],
      ["corner-post", p.cornerPost],
      ["gate", p.gate],
      ["watchpost", p.watch],
      ["hut-a", p.huts[0]],
      ["hut-b", p.huts[1]],
      ["hut-c", p.huts[2]],
      ["tent-a", p.tents[0]],
      ["tent-b", p.tents[1]],
      ["tent-c", p.tents[2]],
      ["bell-tent", p.bell],
      ["well", p.well],
      ["cart", p.cartOpen],
      ["cart-hooded", p.cartHood],
      ["campfire", p.fire],
      ["brazier", p.brazier],
      ["lamp", p.lamp],
      ["weapon-rack", p.rack],
      ["woodpile", p.woodpile],
      ["barrel", p.barrel],
      ["crate-small", p.crateS],
      ["crate-large", p.crateL],
      ["signpost", p.post],
      ["bridge-pier", p.pier],
    ]);
    return this.catalogue;
  }

  private rebuild(): void {
    this.dropMesh();
    this.field = new StructureField();
    const stamp = new SolidStamp(this.field);
    for (const p of this.placed) {
      stamp.add(p.t, p.x, p.y, p.z, p.yaw);
    }
    this.field.build();
    const geo = stamp.acc.toGeometry();
    if (!geo) {
      return;
    }
    const mesh = new THREE.Mesh(geo, this.lib.solidMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.mesh = mesh;
  }

  private dropMesh(): void {
    if (!this.mesh) {
      return;
    }
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose(); // the material is PropLib's and outlives us
    this.mesh = null;
  }
}
