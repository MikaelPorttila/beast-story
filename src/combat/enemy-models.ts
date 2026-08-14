/**
 * WHAT AN ENEMY LOOKS LIKE — one builder per shape, and nothing else.
 *
 * SPLIT OUT OF enemies.ts SO THE SHAPES CAN BE GUARDED (issue #151).
 * `tools/test-zfight.mjs` builds every rig in the game under plain Bun and looks
 * for coincident faces, and it has no content runtime and nothing to boot one
 * with — so a builder sitting beside `content.all()` cannot be walked by it, and
 * these were the only bodies in the game with no z-fighting guard. This file
 * imports the voxel painter and one TYPE, which is the same reason `NPC_BODIES`
 * is a plain module constant (world/npc.ts).
 *
 * The split is the one every body in this project already has: what it LOOKS
 * like is here, what it DOES is `Enemy`'s animators, and who it IS — hit points,
 * palette, aggro — is content.
 */
import * as THREE from "three";
import { VoxelModel, shade } from "../core/voxel";
import type { BeastRig, BeastSpecies } from "../core/types";
import type { EnemyVariant } from "../content/types/enemy";

type Variant = EnemyVariant;

/**
 * A beast body is a `BeastSpecies` rig and posing it needs the whole `BeastRig`,
 * so the rig comes back rather than being rebuilt on the far side of the seam.
 */
export interface EnemyBody {
  readonly parts: Record<string, THREE.Object3D>;
  /** Set by a `beast-…` builder: this wild thing IS a companion species. */
  readonly beast?: { readonly species: BeastSpecies; readonly rig: BeastRig };
}

export type EnemyModel = (root: THREE.Group, v: Variant) => EnemyBody;

function buildGloopling(root: THREE.Group, v: Variant): EnemyBody {
  const m = new VoxelModel();
  m.ellipsoid(0, 3.4, 0, 5.2, 3.4, 4.8, v.dark);
  m.ellipsoid(0, 4.5, 0, 4.7, 3.4, 4.3, v.main);
  m.ellipsoid(0, 3.0, 2.7, 2.8, 2.0, 2.3, v.belly);
  m.set(0, 8, 0, v.main);
  m.set(0, 9, 0, v.main);
  m.set(1, 9, 0, v.main);
  for (const sx of [-2, 2]) {
    m.set(sx, 4, 4, v.accent);
    m.set(sx, 5, 4, v.accent);
    m.set(sx, 6, 4, 0xf4fbff);
  }
  m.set(-1, 3, 4, v.accent);
  m.set(0, 2, 4, v.accent);
  m.set(1, 3, 4, v.accent);
  m.set(-4, 4, 3, 0xff9aa4);
  m.set(4, 4, 3, 0xff9aa4);
  const mesh = m.build(0.1);
  const body = new THREE.Group();
  body.add(mesh);
  root.add(body);
  return { parts: { body } };
}

function buildSnortle(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 4.2, -0.5, 3.8, 3.4, 5.4, v.main);
  bm.ellipsoid(0, 2.8, -0.5, 3.2, 2.2, 4.6, v.belly);
  for (let z = -4; z <= 3; z++) {
    bm.set(0, 8, z, v.dark);
  }
  for (let z = -2; z <= 1; z++) {
    bm.set(0, 9, z, v.dark);
  }
  bm.set(0, 5, -7, v.dark);
  bm.set(0, 6, -7, v.dark);
  bm.set(0, 7, -6, v.dark);
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.3;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  hm.box(0, -2, 0, 2, 2, 3, v.main);
  hm.box(0, -2, 3, 1, 0, 5, v.accent);
  hm.set(1, -1, 5, shade(v.accent, 0.55));
  hm.set(0, -1, 5, shade(v.accent, 0.55));
  hm.set(2, -1, 3, 0xf5efe0);
  hm.set(2, 0, 4, 0xf5efe0);
  hm.set(2, 1, 4, 0xf5efe0);
  hm.box(2, 2, 0, 2, 4, 1, v.dark);
  hm.set(2, 1, 2, 0x14161c);
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  // The 0.02 in Y is the parting offset, not a pose: the ear box stands at the
  // same x as the body's flank, so their side faces shared a plane and fought
  // (0.0048 m2, found the day these shapes got a guard). X cannot be parted on a
  // head — an offset there is an asymmetry you can see — and Z does not reach
  // this pair, so the grids are parted in the one axis left.
  headMesh.position.set(0, -0.22 + 0.02, 0.16);
  const head = new THREE.Group();
  head.position.set(0, 0.76, 0.52);
  head.add(headMesh);
  root.add(head);

  const parts: Record<string, THREE.Object3D> = { body, head };
  const legPositions: Array<[string, number, number]> = [
    ["legFL", -0.2, 0.3],
    ["legFR", 0.2, 0.3],
    ["legBL", -0.2, -0.34],
    ["legBR", 0.2, -0.34],
  ];
  for (const [key, lx, lz] of legPositions) {
    const lm = new VoxelModel();
    lm.box(0, 1, 0, 1, 3, 1, v.dark);
    lm.box(0, 0, 0, 1, 0, 1, shade(v.dark, 0.6));
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.42;
    const leg = new THREE.Group();
    leg.position.set(lx, 0.42, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

function buildPeckitWing(v: Variant, sign: number): THREE.Mesh {
  const wm = new VoxelModel();
  for (let x = 1; x <= 6; x++) {
    const z0 = x <= 3 ? -1 : -1;
    const z1 = x <= 3 ? 2 : 1;
    const col = x <= 3 ? v.main : v.dark;
    for (let z = z0; z <= z1; z++) {
      wm.set(x * sign, 0, z, col);
    }
  }
  wm.set(7 * sign, 0, 0, v.dark);
  wm.set(7 * sign, 0, -1, v.dark);
  return wm.build(0.1, false);
}

function buildPeckit(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 3, -0.5, 2.4, 2.4, 3.6, v.main);
  bm.ellipsoid(0, 2.2, 1.4, 1.7, 1.5, 1.7, v.belly);
  bm.box(-1, 3, -6, 1, 3, -4, v.main);
  bm.set(-2, 3, -6, v.dark);
  bm.set(2, 3, -6, v.dark);
  bm.set(-1, 0, 0, v.accent);
  bm.set(1, 0, 0, v.accent);
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.3;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  hm.ellipsoid(0, 2, 0, 2.1, 2.0, 2.1, v.main);
  hm.box(0, 2, 2, 0, 2, 4, v.accent);
  hm.set(2, 2, 1, 0xf3efe2);
  hm.set(-2, 2, 1, 0xf3efe2);
  hm.set(2, 2, 2, 0x14141c);
  hm.set(-2, 2, 2, 0x14141c);
  hm.set(0, 4, 0, v.dark);
  hm.set(0, 5, -1, v.dark);
  const headMesh = hm.build(0.1);
  headMesh.position.y = -0.18;
  const head = new THREE.Group();
  head.position.set(0, 0.72, 0.34);
  head.add(headMesh);
  body.add(head);

  const wingL = new THREE.Group();
  wingL.position.set(-0.2, 0.34, 0.05);
  wingL.add(buildPeckitWing(v, -1));
  body.add(wingL);
  const wingR = new THREE.Group();
  wingR.position.set(0.2, 0.34, 0.05);
  wingR.add(buildPeckitWing(v, 1));
  body.add(wingR);

  return { parts: { body, head, wingL, wingR } };
}

/**
 * THE BELLWETHER — Act 1's boss (issue #151), and the animal the rest of the
 * valley is following.
 *
 * A bellwether is the lead sheep of a flock and it wears the BELL, so the bell
 * is the model: a heavy horned ram with an iron bell hung at the throat, and
 * the corruption showing in the fleece rather than in a second silhouette. It
 * is a QUADRUPED because it borrows the Snortle's manners (`"behaviour":
 * "snortle"` on the asset) and that animator poses body, head and four legs by
 * name — a boss with a shape of its own must still have the parts the behaviour
 * it picked reaches for.
 *
 * Half again the Snortle's mass. The parting offsets below are the z-fighting
 * rule every rig in this project obeys: two parts share a face grid in an axis
 * exactly where the joint between them is a whole number of voxels, so the head
 * and the legs are hung a fifth of a voxel off it. `bun tools/test-zfight.mjs`
 * is what says whether that is still true.
 */
function buildBellwether(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  // The fleece: a long barrel, deeper than a Snortle's and squarer at the shoulder.
  bm.ellipsoid(0, 6.2, -0.5, 5.4, 4.8, 7.6, v.main);
  bm.ellipsoid(0, 4.2, -0.5, 4.6, 3.0, 6.4, v.belly);
  // Matted ridge along the spine, the one place the corruption reads on the body.
  for (let z = -6; z <= 5; z++) {
    bm.set(0, 11, z, v.dark);
    bm.set(1, 11, z, shade(v.dark, 0.8));
  }
  bm.mirrorX();
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.52;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  // Skull, muzzle, and the horn curling back over the cheek. Painted on one
  // side and mirrored, so the two horns cannot drift apart.
  hm.box(0, -3, 0, 3, 3, 4, v.main);
  hm.box(0, -3, 4, 2, 0, 7, v.accent);
  hm.set(2, -2, 7, shade(v.accent, 0.5));
  hm.set(3, 1, 3, 0x14161c); // eye
  const horn = shade(v.dark, 1.15);
  hm.box(3, 4, 0, 4, 4, 2, horn);
  hm.box(4, 3, -1, 5, 4, 0, horn);
  hm.box(4, 1, -1, 5, 2, 1, horn);
  hm.box(4, 0, 1, 5, 1, 3, horn);
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  headMesh.position.set(0, -0.3, 0.2);
  const head = new THREE.Group();
  // 0.02 forward of the joint, which is the fifth of a voxel that parts the
  // head's z-grid from the body's — see npc-gain.ts, which argues it at length.
  head.position.set(0, 1.18, 0.78 + 0.02);
  head.add(headMesh);
  root.add(head);

  // THE BELL, on its own model and hung under the throat: it is the one piece
  // that is not the animal, and it is what the quest is named for.
  const cm = new VoxelModel();
  cm.box(-2, 0, -1, 1, 0, 1, 0x6b4a2e); // the strap
  cm.ellipsoid(-0.5, -2, 0, 2.0, 2.0, 1.8, 0xc9a24f);
  cm.box(-1, -4, -1, 0, -4, 0, shade(0xc9a24f, 0.6)); // the clapper
  const bellMesh = cm.build(0.1);
  const bell = new THREE.Group();
  bell.position.set(0, -0.34, 0.26);
  bell.add(bellMesh);
  head.add(bell);

  const parts: Record<string, THREE.Object3D> = { body, head, bell };
  const legPositions: Array<[string, number, number]> = [
    ["legFL", -0.32, 0.44],
    ["legFR", 0.32, 0.44],
    ["legBL", -0.32, -0.48],
    ["legBR", 0.32, -0.48],
  ];
  for (const [key, lx, lz] of legPositions) {
    const lm = new VoxelModel();
    lm.box(0, 1, 0, 2, 5, 2, v.dark);
    lm.box(0, 0, 0, 2, 0, 2, shade(v.dark, 0.55)); // the hoof
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.62;
    const leg = new THREE.Group();
    // Outboard by the same fifth of a voxel, away from the body's own grid.
    leg.position.set(lx + Math.sign(lx) * 0.02, 0.62, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

/**
 * The shapes, by name. An asset picks one with `"model": "gloopling"`;
 * `enemies.ts` publishes the map to the content layer at module load, and
 * `test-zfight` walks it. A shape is in here or it is in neither.
 */
/**
 * THE THREAD ANCHOR — the knot `quest:land/the-red-thread` is wound onto, and
 * the first enemy that is an OBJECT rather than an animal (issue #202): coils
 * of red cord wound over an angular shard, half-sunk in the Hold's floor. ONE
 * VoxelModel on purpose — a single mesh has no cross-model planes, so it
 * cannot z-fight with itself — and `Enemy.update` gives the behaviour of the
 * same name no gait at all.
 */
function buildThreadAnchor(root: THREE.Group, v: Variant): EnemyBody {
  const m = new VoxelModel();
  // The shard: a crooked stack, each course stepping one voxel, dark against
  // the cord. Angular is the brief — nothing here is an ellipsoid.
  m.box(-3, 0, -3, 3, 1, 2, v.accent);
  m.box(-2, 2, -2, 2, 4, 1, shade(v.accent, 1.5));
  m.box(-1, 5, -1, 1, 7, 1, v.accent);
  m.box(0, 8, 0, 1, 10, 1, shade(v.accent, 1.9));
  // The coils. A ring of cord one voxel thick, wound where the shard tapers;
  // every third voxel is the dark strand, so the cord reads as twisted rather
  // than as a painted stripe. The slight y-wobble is the winding's pitch.
  const coil = (cy: number, r: number, wobble: number, phase: number): void => {
    for (let a = 0; a < 40; a++) {
      const th = (a / 40) * Math.PI * 2;
      const x = Math.round(Math.cos(th) * r);
      const z = Math.round(Math.sin(th) * r * 0.9);
      const y = cy + Math.round(Math.sin(th * 2 + phase) * wobble);
      m.set(x, y, z, a % 3 === 2 ? v.dark : v.main);
    }
  };
  coil(2, 4.6, 1, 0.4);
  coil(4, 4.1, 1, 2.1);
  coil(6, 3.2, 0, 3.6);
  coil(7, 2.9, 1, 1.2);
  // The loose end: off the top coil, down the shard's lee, and away along the
  // floor — the thread on its way to the pen. Frays in the pale belly tone.
  const trail: Array<[number, number, number]> = [
    [3, 7, 0],
    [4, 6, 1],
    [4, 5, 2],
    [5, 3, 2],
    [5, 1, 3],
    [6, 0, 3],
    [7, 0, 4],
    [8, 0, 4],
  ];
  for (const [x, y, z] of trail) {
    m.set(x, y, z, v.main);
  }
  // Frays a step lighter than the cord, never the pale belly tone: an isolated
  // bright voxel on open ground reads as a floating white fleck from the road.
  m.set(5, 0, 5, shade(v.main, 1.3));
  m.set(9, 0, 3, shade(v.main, 1.3));
  m.set(-4, 0, -1, shade(v.main, 1.3));
  const mesh = m.build(0.1);
  const body = new THREE.Group();
  // HALF-SUNK: an object left in a cellar, not a thing standing on a floor.
  mesh.position.y = -0.25;
  body.add(mesh);
  root.add(body);
  return { parts: { body } };
}

export const ENEMY_MODELS: ReadonlyMap<string, EnemyModel> = new Map<string, EnemyModel>([
  ["gloopling", buildGloopling],
  ["snortle", buildSnortle],
  ["peckit", buildPeckit],
  ["bellwether", buildBellwether],
  ["thread-anchor", buildThreadAnchor],
]);
