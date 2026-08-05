import * as THREE from 'three';
import { VoxelModel } from '../core/voxel';
import { buildWeaponModel, disposeWeapon, type WeaponModelId } from './weapons';

/**
 * Voxel hero: a charming Cube World adventurer, ~1.9 units tall.
 * Built as a hierarchy of pivot groups so the animator can pose joints:
 *
 *   root (player position, yaw)
 *    └ body (bob / lean / squash)
 *       ├ legL, legR        (hip pivots)
 *       └ torso (twist)
 *          ├ head            (neck pivot)
 *          ├ armL (+shield)  (shoulder pivot)
 *          └ armR (+sword)   (shoulder pivot)
 */
export interface HeroRig {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /**
   * THE HAND, not a sword — the mount a weapon model hangs in. Named for what
   * it held when there was only one thing to hold; see `setWeaponModel`.
   */
  sword: THREE.Group;
  shield: THREE.Group;
  /** every material in the rig, for damage flash */
  materials: THREE.MeshStandardMaterial[];
  /** What is in the hand right now, or null for bare hands. */
  weapon: WeaponModelId | null;
}

// -- palette ---------------------------------------------------------------
const SKIN = 0xf6c69a;
const SKIN_EAR = 0xefb684;
const BLUSH = 0xf59f7d;
const MOUTH = 0xa9603f;
const EYE = 0x2c2833;
const GLINT = 0xffffff;
const HAIR = 0xa5622a;
const HAIR_D = 0x84491d;
const HAIR_L = 0xb97a3d; // sun-lightened strands (back of head)
const STRAP = 0xc9a24f;  // gold-tan backpack straps
const TUNIC = 0x3f8fd6;
const TUNIC_D = 0x3374b3;
const TRIM = 0xf2d98b;
const BELT = 0x63452a;
const BELT_D = 0x4c3420;
const PANTS = 0x597040; // forest green pants
const BOOT = 0x7d5433;
const BOOT_D = 0x654325;
// Steel reads a full stop darker than the sky dome (0xcfe8f4) so the blade is a
// silhouette against it instead of vanishing into the same value.
const STEEL = 0xa9b8c6;
const STEEL_L = 0xeef4f9;
const STEEL_D = 0x76858f;
const GOLD = 0xe6a93c;
const GRIP = 0x5b3f26;
const WOOD = 0xa06f41;
const POUCH = 0x8a6238;

const S = 0.1; // voxel scale: 1 voxel = 0.1 m

const HIP_Y = 0.6;
const TORSO_Y = 0.55;
const SHOULDER_LOCAL_Y = 0.53; // within torso group
const SHOULDER_X = 0.43; // mitts tuck against the torso instead of floating wide
const NECK_LOCAL_Y = 0.58;
/** Head is shrunk relative to the body to match Cube World's head:body ratio. */
const HEAD_SCALE = 0.7;

function buildHead(): THREE.Mesh {
  const v = new VoxelModel();
  // skull
  v.box(-4, 0, -4, 3, 5, 3, SKIN);
  // hair: chunky cap with a one-voxel overhang all around
  v.box(-5, 4, -5, 4, 6, 4, HAIR);
  // darker under-layer at the back, flowing down the neck
  v.box(-5, 1, -5, 4, 3, -4, HAIR_D);
  // back strands: recolor the outer back layer (z=-5) with 2-tone columns so
  // the rear view reads as falling hair, not a flat slab (no shape change)
  for (const y of [1, 2, 3]) v.set(-4, y, -5, HAIR);
  for (const y of [2, 3]) v.set(0, y, -5, HAIR);
  for (const y of [1, 2]) v.set(3, y, -5, HAIR);
  for (const y of [1, 2, 3]) v.set(-2, y, -5, HAIR_L);
  v.set(2, 3, -5, HAIR_L);
  // carry the variation up into the back of the cap
  v.set(-3, 4, -5, HAIR_D);
  v.set(1, 4, -5, HAIR_D);
  v.set(-1, 5, -5, HAIR_L);
  v.set(3, 4, -5, HAIR_D);
  // jagged fringe over the brow
  for (const x of [-5, -3, -1, 2, 4]) v.set(x, 3, 4, HAIR);
  for (const x of [-4, 0, 3]) v.set(x, 3, 4, HAIR_D);
  // cowlick tuft
  v.set(-1, 7, -1, HAIR);
  v.set(0, 7, 0, HAIR);
  v.set(0, 8, -1, HAIR_D);
  // ears
  v.set(-5, 2, 0, SKIN_EAR);
  v.set(4, 2, 0, SKIN_EAR);
  // eyes: 2x2 dark with a white glint, on the front face layer
  for (let y = 2; y <= 3; y++) {
    v.set(-3, y, 3, EYE);
    v.set(-2, y, 3, EYE);
    v.set(1, y, 3, EYE);
    v.set(2, y, 3, EYE);
  }
  v.set(-2, 3, 3, GLINT);
  v.set(1, 3, 3, GLINT);
  // little smile + rosy cheeks
  v.set(-1, 0, 3, MOUTH);
  v.set(0, 0, 3, MOUTH);
  v.set(-4, 1, 3, BLUSH);
  v.set(3, 1, 3, BLUSH);
  const mesh = v.build(S, true);
  mesh.position.y = -0.03;
  return mesh;
}

function buildTorso(): THREE.Mesh {
  const v = new VoxelModel();
  // tunic
  v.box(-4, 0, -2, 3, 5, 1, TUNIC);
  // shaded sides for a bit of volume
  v.box(-4, 1, -2, -4, 4, 1, TUNIC_D);
  v.box(3, 1, -2, 3, 4, 1, TUNIC_D);
  // belt + gold buckle
  v.box(-4, 0, -2, 3, 0, 1, BELT);
  v.set(0, 0, 1, GOLD);
  v.set(-1, 0, 1, GOLD);
  // collar trim
  v.box(-4, 5, -2, 3, 5, 1, TRIM);
  // satchel strap: diagonal across the chest
  for (let i = 0; i <= 5; i++) v.set(3 - i, i, 1, BELT_D);
  // backpack straps: gold-tan X crossing the tunic back (flush recolor of the
  // z=-2 back layer, so the silhouette is untouched); stops below the collar
  for (let i = 0; i <= 4; i++) {
    v.set(3 - i, i, -2, STRAP);  // right shoulder -> left hip
    v.set(-4 + i, i, -2, STRAP); // left shoulder -> right hip
  }
  return v.build(S, true);
}

function buildLeg(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-1, 2, -1, 1, 5, 1, PANTS);
  v.box(-1, 0, -1, 1, 1, 1, BOOT);
  // boot cuff + toe cap
  v.box(-1, 2, -1, 1, 2, 1, BOOT_D);
  v.box(-1, 0, 2, 1, 0, 2, BOOT);
  const mesh = v.build(S, true);
  mesh.position.y = -HIP_Y;
  return mesh;
}

/**
 * Cube World-style arm: a dark rounded pauldron at the shoulder flowing
 * straight into an oversized spherical mitt — no thin forearm in between.
 */
function buildArm(braced: boolean): THREE.Mesh {
  const v = new VoxelModel();
  // pauldron cap sitting on the shoulder, tucked against the torso
  v.ellipsoid(0, 4.2, 0, 2.0, 1.7, 2.0, TUNIC_D);
  v.ellipsoid(0, 4.9, 0, 1.7, 1.1, 1.7, TRIM);
  // Connective upper arm. The old 3-wide sleeve pinched to a 3x3 waist right
  // under the 5-wide pauldron, so from the play camera the mitt read as a
  // detached cube hanging below the shoulder. The bridging ellipsoid is
  // pauldron-width at the shoulder and mitt-width where it meets the hand, so
  // the silhouette is continuous from pauldron to mitt.
  v.box(-1, 1, -1, 1, 4, 1, TUNIC_D);
  v.ellipsoid(0, 2.7, 0, 2.1, 1.8, 2.1, TUNIC_D);
  // big spherical hand
  const glove = braced ? BELT : SKIN;
  v.ellipsoid(0, 0.6, 0, 2.4, 2.3, 2.4, glove);
  if (braced) {
    // cuff band where the bracer meets the mitt
    v.ellipsoid(0, 2.2, 0, 2.1, 0.6, 2.1, BELT_D);
  } else {
    v.ellipsoid(0, 2.2, 0, 2.1, 0.6, 2.1, SKIN_EAR);
  }
  const mesh = v.build(S, true);
  mesh.position.y = -0.55;
  return mesh;
}

function buildShield(): THREE.Mesh {
  const v = new VoxelModel();
  for (let y = 0; y <= 4; y++) {
    const half = y === 0 || y === 4 ? 1 : 2;
    for (let x = -half; x <= half; x++) {
      const rim = Math.abs(x) === half || y === 0 || y === 4;
      v.set(x, y, 0, rim ? STEEL_D : WOOD);
    }
  }
  // blue emblem diamond + gold boss sticking out
  v.set(0, 1, 0, TUNIC);
  v.set(0, 3, 0, TUNIC);
  v.set(-1, 2, 0, TUNIC);
  v.set(1, 2, 0, TUNIC);
  v.set(0, 2, 1, GOLD);
  const mesh = v.build(S, true);
  mesh.position.y = -0.24;
  return mesh;
}

function buildSatchel(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(0, 0, 0, 3, 2, 1, POUCH);
  v.box(0, 3, 0, 3, 3, 1, BELT_D);
  v.set(1, 2, 1, GOLD); // clasp
  // rear detail: the local +x face points backward once the satchel is
  // rotated onto the hip, so give it a dark seam + stud to read from behind
  v.set(3, 0, 0, BELT_D);
  v.set(3, 0, 1, BELT_D);
  v.set(3, 2, 0, GOLD);
  const mesh = v.build(S, true);
  mesh.position.y = -0.2;
  return mesh;
}

function buildScabbard(): THREE.Mesh {
  // slim leather strip with a gold throat and steel chape; hangs below its
  // pivot so the group can angle it from the belt line
  const v = new VoxelModel();
  v.box(0, 0, 0, 0, 4, 0, BELT_D);
  v.set(0, 4, 0, GOLD);    // throat band at the belt
  v.set(0, 0, 0, STEEL_D); // chape tip
  const mesh = v.build(S, true);
  mesh.position.y = -0.48;
  return mesh;
}

export function buildHeroRig(): HeroRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legL = new THREE.Group();
  legL.position.set(-0.19, HIP_Y, 0);
  legL.add(buildLeg());
  const legR = new THREE.Group();
  legR.position.set(0.19, HIP_Y, 0);
  legR.add(buildLeg());
  body.add(legL, legR);

  const torso = new THREE.Group();
  torso.position.y = TORSO_Y;
  torso.add(buildTorso());
  body.add(torso);

  const head = new THREE.Group();
  head.position.y = NECK_LOCAL_Y;
  // Cube World proportions: the head is roughly a third of the body, not half.
  head.scale.setScalar(HEAD_SCALE);
  head.add(buildHead());
  torso.add(head);

  const armL = new THREE.Group();
  armL.position.set(-SHOULDER_X, SHOULDER_LOCAL_Y, 0);
  armL.add(buildArm(true));
  const armR = new THREE.Group();
  armR.position.set(SHOULDER_X, SHOULDER_LOCAL_Y, 0);
  armR.add(buildArm(false));
  torso.add(armL, armR);

  // Rest pose: hilt sits in the mitt, blade angled back past the calf and
  // yawed off-axis so the flat of the blade never faces the camera square-on.
  // NOTE: the animator overwrites sword.rotation.x/.z every frame (idle x≈2.62),
  // so rotation.x here is only the pre-animation pose; rotation.y and position
  // are ours alone and are what actually shape the rest silhouette. The blade
  // was hidden behind the right leg, so the fix lives in the axes we own:
  // yaw turns the flat of the blade towards the camera and the position pushes
  // the whole weapon outboard of the calf and up out of the boot line.
  // `sword` is the HAND, not a sword: it is the mount everything the hero can
  // hold hangs off, and `setWeaponModel` swaps what is in it. The name is kept
  // because the animator writes `rig.sword.rotation` on every frame and
  // renaming it would touch every pose in player/animations.ts for nothing.
  // Its own scale is 1 — per-weapon size lives in `FIT` (player/weapons.ts),
  // so a dagger and a greatsword differ without five sets of keyframes.
  const sword = new THREE.Group();
  sword.position.set(0.10, -0.26, -0.04);
  sword.rotation.x = 2.05;
  sword.rotation.y = 0.85;
  armR.add(sword);

  const shield = new THREE.Group();
  shield.position.set(-0.06, -0.3, 0.13);
  shield.add(buildShield());
  armL.add(shield);

  const satchel = buildSatchel();
  satchel.position.set(-0.47, 0.72, -0.02);
  satchel.rotation.y = Math.PI / 2;
  satchel.rotation.z = 0.08;
  body.add(satchel);

  // scabbard on the left hip, angled tip-back so it reads from behind.
  // Kept low (top y~0.66) and behind (z<=-0.15): the arm swing arc only
  // reaches z=-0.15 at y>~0.90, and the leg sweep stays inboard of x=-0.34.
  const scabbard = new THREE.Group();
  scabbard.position.set(-0.38, 0.66, -0.2);
  scabbard.rotation.x = 0.3;
  scabbard.rotation.z = -0.15;
  scabbard.add(buildScabbard());
  body.add(scabbard);

  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // The hero CASTS but never RECEIVES. VoxelModel.build() turns both on, and
    // on a rig built from separate parts a few centimetres apart that means the
    // hero shadows himself: the hat brim printed a hard band straight across his
    // eyes, and faces near-parallel to the sun picked up the diagonal hatching
    // of shadow-map acne. Both land on the one part that has to read at a
    // glance, and both are gone with receiving off.
    //
    // castShadow stays ON — his contact shadow is what keeps him standing on the
    // ground rather than floating over it. The cost is that he no longer darkens
    // in shade, which matters more now that trees are tall enough to cast real
    // shade; three has no per-object "receive the world's shadows but not my
    // own", so it is one or the other. Beasts make the same trade (beasts/framework).
    mesh.receiveShadow = false;
    if (mesh.material instanceof THREE.MeshStandardMaterial) {
      materials.push(mesh.material);
    }
  });

  const rig: HeroRig = {
    root, body, torso, head, armL, armR, legL, legR, sword, shield, materials,
    weapon: null,
  };
  setWeaponModel(rig, 'sword');
  return rig;
}

/**
 * Put a weapon in the hero's hand, or empty it.
 *
 * The materials of the OUTGOING model go with it — `materials` on the rig is
 * the damage-flash list, and a weapon that has been unequipped must not still
 * be flashed white when he is hit. Nothing else in the rig is ever removed, so
 * this is the one place that has to prune it.
 */
export function setWeaponModel(rig: HeroRig, id: WeaponModelId | null): void {
  if (rig.weapon === id) return;
  rig.weapon = id;
  const held = rig.sword.children[0] as THREE.Mesh | undefined;
  if (held) {
    rig.sword.remove(held);
    const mat = held.material as THREE.MeshStandardMaterial;
    const at = rig.materials.indexOf(mat);
    if (at >= 0) rig.materials.splice(at, 1);
    disposeWeapon(held);
  }
  if (!id) return;
  const mesh = buildWeaponModel(id);
  rig.sword.add(mesh);
  rig.materials.push(mesh.material as THREE.MeshStandardMaterial);
}
