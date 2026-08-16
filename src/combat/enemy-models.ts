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

/**
 * THE BRIDLE-HOUND (issue #232) — the drowned market's guardian, already on the
 * Bridle order's rope when the player arrives. The COLLAR IS THE STORY: it and
 * the taut lead down to a stake are painted in `v.accent`, which every variant
 * keeps at the red-thread hex, tying the leash to Act 1's threads. The part set
 * is the standard quadruped (body, head, four legs) so a borrowed behaviour can
 * pose it the day it needs to move; today it stands its post.
 */
function buildBridleHound(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  // Leaner than a Snortle: a working dog's barrel, ribs showing at the flanks.
  bm.ellipsoid(0, 4.4, -0.4, 2.8, 2.8, 5.2, v.main);
  bm.ellipsoid(0, 3.2, 0.2, 2.3, 1.8, 4.0, v.belly);
  for (const z of [-2, 0, 2]) {
    bm.set(-3, 4, z, v.dark);
    bm.set(3, 4, z, v.dark);
  }
  // The tail, tucked low — leashed, not cowed.
  bm.set(0, 3, -6, v.dark);
  bm.set(0, 2, -7, v.dark);
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.34;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  hm.box(0, -1, 0, 2, 2, 2, v.main);
  // A long muzzle, grey at the lip: this animal has kept posts before this one.
  hm.box(0, -1, 2, 1, 0, 5, v.dark);
  hm.set(0, 0, 5, shade(v.belly, 0.9));
  hm.set(2, 1, 1, 0xe8b23c);
  // Ears up: it is WORKING, which is Coil's whole case about it.
  hm.box(1, 2, -1, 2, 4, 0, v.dark);
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  // 0.02 Y parting, the snortle ear rule: the ear grid meets the body flank plane.
  headMesh.position.set(0, -0.18 + 0.02, 0.14);
  const head = new THREE.Group();
  head.position.set(0, 0.86, 0.56);
  head.add(headMesh);
  root.add(head);

  // THE COLLAR AND THE LEAD — accent red, and the lead runs taut to a stake the
  // wardens drove beside the post. Its own grid, parted 0.02 in X from the body.
  const cm = new VoxelModel();
  for (const [cy, cz] of [
    [1, 1],
    [2, 0],
    [2, -1],
    [1, -2],
  ] as const) {
    cm.set(-2, cy, cz, v.accent);
    cm.set(2, cy, cz, v.accent);
  }
  for (let z = -1; z <= 1; z++) {
    cm.set(0, 3, z, v.accent);
    cm.set(0, 0, z, v.accent);
  }
  // The lead, stepping down and out to the stake.
  cm.set(3, 0, -1, v.accent);
  cm.set(4, -1, -2, v.accent);
  cm.set(5, -2, -2, v.accent);
  cm.set(6, -3, -3, v.accent);
  cm.set(6, -4, -3, shade(v.dark, 0.5));
  cm.set(6, -5, -3, shade(v.dark, 0.5));
  const collarMesh = cm.build(0.1);
  collarMesh.position.set(0.02, 0, 0);
  const collar = new THREE.Group();
  collar.position.set(0, 0.72, 0.42);
  collar.add(collarMesh);
  root.add(collar);

  const parts: Record<string, THREE.Object3D> = { body, head, collar };
  const legPositions: Array<[string, number, number]> = [
    ["legFL", -0.18, 0.3],
    ["legFR", 0.18, 0.3],
    ["legBL", -0.18, -0.3],
    ["legBR", 0.18, -0.3],
  ];
  for (const [key, lx, lz] of legPositions) {
    const lm = new VoxelModel();
    lm.box(0, 1, 0, 1, 4, 1, v.main);
    lm.box(0, 0, 0, 1, 0, 1, shade(v.dark, 0.6));
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.5;
    const leg = new THREE.Group();
    // Parted in X AND Z: a lean hound's leg fronts meet the barrel's own planes.
    leg.position.set(lx + Math.sign(lx) * 0.02, 0.5, lz + Math.sign(lz) * 0.02);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

/**
 * THE BRINEHOLDER (issue #236) — what has been holding the third component
 * under Maw's Rest. A reef grown into an animal: the shell ridge carries coral
 * spurs whose TIPS are `v.accent` — the red thread, because what it is holding
 * is a leash with the other end in the Bond Engine. Boss bulk on the standard
 * quadruped part set (body, head, four legs), fought in and under water.
 */
function buildBrineholder(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 5.2, 0, 7.4, 4.6, 9.2, v.main);
  bm.ellipsoid(0, 3.4, 0.6, 6.2, 3.0, 7.6, v.belly);
  // The SHELL: a dark reef dome grown over the spine.
  bm.ellipsoid(0, 8.0, -1.0, 5.6, 3.2, 6.6, v.dark);
  bm.ellipsoid(0, 8.8, -1.0, 4.4, 2.6, 5.2, shade(v.dark, 0.8));
  // Coral spurs off the ridge, red at the tips — the thread showing through.
  for (const [sx, sy, sz] of [
    [0, 11, -4],
    [-2, 11, -1],
    [2, 11, -1],
    [0, 12, 1],
    [-3, 10, 2],
    [3, 10, 2],
  ] as const) {
    bm.set(sx, sy, sz, shade(v.main, 0.75));
    bm.set(sx, sy + 1, sz, v.accent);
  }
  // Barnacle pale flecks along the flanks: it has been down there a long time.
  for (const [fx, fy, fz] of [
    [-6, 5, 3],
    [6, 4, -2],
    [-5, 3, -4],
    [6, 6, 2],
    [-7, 4, 0],
  ] as const) {
    bm.set(fx, fy, fz, 0xd8d2c0);
  }
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.6;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  hm.box(0, -2, 0, 3, 2, 4, v.main);
  hm.box(0, -3, 3, 2, -1, 6, v.dark);
  // Deep-set lamps of eyes: it wakes hungry.
  hm.set(3, 0, 2, 0xeafffb);
  hm.set(3, 1, 2, shade(v.accent, 1.1));
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  // 0.02 Y parting: the jaw grid meets the belly plane at the neck.
  headMesh.position.set(0, -0.2 + 0.02, 0.3);
  const head = new THREE.Group();
  head.position.set(0, 0.9, 1.06);
  head.add(headMesh);
  root.add(head);

  const parts: Record<string, THREE.Object3D> = { body, head };
  // Flipper-footed pillars: it walks the bed and paddles the channel alike.
  const legPositions: Array<[string, number, number]> = [
    ["legFL", -0.52, 0.58],
    ["legFR", 0.52, 0.58],
    ["legBL", -0.52, -0.6],
    ["legBR", 0.52, -0.6],
  ];
  for (const [key, lx, lz] of legPositions) {
    const lm = new VoxelModel();
    lm.box(-1, 2, -1, 1, 5, 1, v.main);
    lm.box(-2, 0, -2, 2, 1, 2, v.dark);
    lm.box(-2, 0, 2, 2, 0, 3, shade(v.dark, 0.7));
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.62;
    const leg = new THREE.Group();
    leg.position.set(lx + Math.sign(lx) * 0.02, 0.62, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

/**
 * THE CINDERGUARD — what a century in the red does to something that was set to
 * guard a vent and never told to stop (issues #160, #263).
 *
 * Slag, not an animal: a burnt mass with the fire still in its cracks, three
 * exhaust stacks fused along its spine, and a head carried too low because it
 * has been walking the same circuit since the shelf burned. The accent is the
 * engine's own exhaust and it only ever shows in the FISSURES — a coat of it
 * would read as a lava beast, and this thing is cold rock with a fire inside.
 */
function buildCinderguard(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 5.4, 0, 7.0, 4.4, 9.0, v.main);
  bm.ellipsoid(0, 3.6, 0.4, 5.8, 2.8, 7.4, v.belly);
  // The crust: a darker plate over the back, cracked along the spine.
  bm.ellipsoid(0, 8.2, -0.8, 5.4, 3.0, 7.0, v.dark);
  // ...and the fire in the cracks. A line, broken, never a field.
  for (const z of [-6, -4, -1, 1, 4, 6]) {
    bm.set(0, 11, z, v.accent);
    bm.set(1, 10, z + 1, shade(v.accent, 0.7));
  }
  // Three exhaust stacks, lit at the throat. Fused INTO the crust, so they are
  // part of the same mass rather than chimneys standing on it.
  for (const [sx, sz] of [
    [-3, -3],
    [3, -3],
    [0, 3],
  ] as const) {
    bm.box(sx - 1, 10, sz - 1, sx + 1, 12, sz + 1, shade(v.dark, 0.85));
    bm.set(sx, 13, sz, v.accent);
  }
  // Cooled spatter down the flanks — it has been vented on for a hundred years.
  for (const [fx, fy, fz] of [
    [-6, 4, 3],
    [6, 3, -2],
    [-5, 2, -5],
    [6, 5, 2],
  ] as const) {
    bm.set(fx, fy, fz, shade(v.dark, 0.6));
  }
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.6;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  // A blunt wedge with no jaw to speak of: it does not eat, it walks.
  hm.box(0, -2, 0, 3, 2, 5, v.main);
  hm.box(0, -3, 4, 2, 0, 7, v.dark);
  // The eyes are vents too — the same fire, seen end-on.
  hm.set(3, 1, 4, v.accent);
  hm.set(3, 0, 5, shade(v.accent, 0.6));
  // The red thread, worn as tack: the collar is what is holding it to the engine.
  hm.box(0, -1, -1, 3, -1, -1, 0xc4423c);
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  // 0.02 parts the head's grid from the body's at the neck — the Bellwether's rule.
  headMesh.position.set(0, -0.24 + 0.02, 0.3);
  const head = new THREE.Group();
  head.position.set(0, 0.82, 1.02);
  head.add(headMesh);
  root.add(head);

  const parts: Record<string, THREE.Object3D> = { body, head };
  // Pillars, not limbs: it is held up rather than carried.
  for (const [key, lx, lz] of [
    ["legFL", -0.5, 0.56],
    ["legFR", 0.5, 0.56],
    ["legBL", -0.5, -0.58],
    ["legBR", 0.5, -0.58],
  ] as Array<[string, number, number]>) {
    const lm = new VoxelModel();
    lm.box(-1, 2, -1, 1, 5, 1, v.main);
    lm.box(-2, 0, -2, 2, 1, 2, v.dark);
    // One ember at the ankle, where the crust has split under the weight.
    lm.set(0, 2, 2, shade(v.accent, 0.8));
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.62;
    const leg = new THREE.Group();
    leg.position.set(lx + Math.sign(lx) * 0.02, 0.62, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

/**
 * THE CHOIRGUARD — the Bond Engine's own defence, built to keep time (issues
 * #161, #263), and the reason Vess cannot simply hand the Orrery over.
 *
 * Brass and made, where the Cinderguard is burnt and worn: a ribbed drum of a
 * body carrying a ring of tuned bars, a head that is mostly an armature, and
 * the red thread through the middle of it. Nothing here is organic — the
 * silhouette is an instrument that happens to walk.
 */
function buildChoirguard(root: THREE.Group, v: Variant): EnemyBody {
  const bm = new VoxelModel();
  bm.ellipsoid(0, 5.6, 0, 6.6, 4.6, 8.6, v.main);
  bm.ellipsoid(0, 3.8, 0.4, 5.4, 3.0, 7.0, v.belly);
  // Ribs: the drum is banded, and the bands are what it rings with.
  for (const z of [-6, -3, 0, 3, 6]) {
    bm.box(-6, 9, z, 6, 9, z, shade(v.dark, 1.2));
  }
  // THE RING OF BARS over the back — tuned lengths, tallest at the shoulder.
  const bars: ReadonlyArray<readonly [number, number, number]> = [
    [-4, 3, -4],
    [-2, 4, -1],
    [0, 5, 1],
    [2, 4, -1],
    [4, 3, -4],
  ];
  for (const [bx, h, bz] of bars) {
    bm.box(bx, 10, bz, bx, 10 + h, bz, shade(v.main, 1.25));
    bm.set(bx, 11 + h, bz, v.dark);
  }
  // The thread runs THROUGH it, not over it: the engine holds this one too.
  for (let z = -5; z <= 5; z += 2) {
    bm.set(0, 12, z, v.accent);
  }
  const bodyMesh = bm.build(0.1);
  const body = new THREE.Group();
  body.position.y = 0.62;
  body.add(bodyMesh);
  root.add(body);

  const hm = new VoxelModel();
  // An armature rather than a skull: two arcs and the lens between them.
  hm.box(0, -2, 0, 2, 2, 3, v.dark);
  hm.box(2, -1, 1, 3, 3, 2, shade(v.main, 1.2));
  hm.box(2, 3, 2, 3, 3, 5, shade(v.main, 1.2));
  hm.set(0, 1, 5, v.accent);
  hm.set(1, 1, 5, shade(v.accent, 0.7));
  hm.mirrorX();
  const headMesh = hm.build(0.1);
  headMesh.position.set(0, -0.2 + 0.02, 0.28);
  const head = new THREE.Group();
  head.position.set(0, 1.0, 1.0);
  head.add(headMesh);
  root.add(head);

  const parts: Record<string, THREE.Object3D> = { body, head };
  // Jointed brass legs: a stand under an instrument, and it steps like one.
  for (const [key, lx, lz] of [
    ["legFL", -0.48, 0.54],
    ["legFR", 0.48, 0.54],
    ["legBL", -0.48, -0.56],
    ["legBR", 0.48, -0.56],
  ] as Array<[string, number, number]>) {
    const lm = new VoxelModel();
    lm.box(-1, 2, -1, 1, 5, 1, shade(v.main, 1.1));
    lm.box(-1, 4, -1, 1, 4, 1, v.dark); // the joint collar
    lm.box(-2, 0, -2, 2, 1, 2, v.dark);
    const legMesh = lm.build(0.1);
    legMesh.position.y = -0.62;
    const leg = new THREE.Group();
    leg.position.set(lx + Math.sign(lx) * 0.02, 0.62, lz);
    leg.add(legMesh);
    root.add(leg);
    parts[key] = leg;
  }
  return { parts };
}

export const ENEMY_MODELS: ReadonlyMap<string, EnemyModel> = new Map<string, EnemyModel>([
  ["gloopling", buildGloopling],
  ["snortle", buildSnortle],
  ["peckit", buildPeckit],
  ["bellwether", buildBellwether],
  ["thread-anchor", buildThreadAnchor],
  ["bridle-hound", buildBridleHound],
  ["brineholder", buildBrineholder],
  ["cinderguard", buildCinderguard],
  ["choirguard", buildChoirguard],
]);
