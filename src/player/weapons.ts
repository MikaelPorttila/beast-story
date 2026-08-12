import * as THREE from "three";
import { VoxelModel } from "../core/voxel";

/**
 * THE FIVE THINGS THE HERO CAN BE HOLDING — and the sixth case, holding
 * nothing.
 *
 * Issue #74's gear slot only meant something as a number until now: equipping a
 * scythe raised `attackStat` and the hero went on swinging the same iron sword.
 * These are the models that make the slot visible, one per weapon icon in the
 * atlas, built out of voxels like everything else the renderer draws.
 *
 * THE ONE-VOXEL PLANK PROBLEM, and every model here is shaped around it. A
 * blade drawn as a single 1-voxel-thick plane is caught nearly edge-on by the
 * gameplay camera behind the hero's leg and disappears — that is the note
 * already on the original sword, and it applies to all five. So each of these
 * has a STEPPED cross-section: a bright edge column, a body column and a spine
 * one voxel deeper, so at least one lit face is always turned toward the
 * camera. The bow is the exception and gets its depth from being a curve.
 *
 * SCALE IS THE RIG'S, NOT THE MODEL'S. Every builder works in the same 0.1 m
 * voxel and puts the GRIP at the origin, with the business end running up +Y;
 * `hero-rig.ts` mounts the result in the hand group that the animator already
 * rotates, so a weapon needs no per-weapon animation and none of the swing
 * keyframes had to move. The only per-weapon number is `scale`, below, which is
 * how a dagger is short and a greatsword is long without five sets of poses.
 */

const S = 0.1;

// Shared with the hero's own palette (hero-rig.ts). Restated rather than
// exported across, because these are a WEAPON's colours: if the hero's steel
// ever changes for a reason about his armour, a sword blade should not follow
// it silently.
const STEEL = 0xa9b8c6;
const STEEL_L = 0xeef4f9;
const STEEL_D = 0x76858f;
const GOLD = 0xe6a93c;
const GRIP = 0x5b3f26;
const WRAP = 0x4c3420;
const WOOD = 0xa06f41;
const WOOD_D = 0x7d5433;
const HORN = 0xd9c9a3;
const DARK = 0x3a3f46;

/**
 * Which model hangs in the hand. `null` is bare hands.
 *
 * The list is exported as a VALUE too, because `ItemDef.model` is a plain
 * string (core/ may not import player/) and both the rig and the inventory's
 * stage have to guard one on the way in.
 */
export const WEAPON_MODEL_IDS = ["sword", "greatsword", "bow", "scythe", "dagger"] as const;
export type WeaponModelId = (typeof WEAPON_MODEL_IDS)[number];

/**
 * How the hand holds each one.
 *
 * `scale` is the whole of "a dagger is small": one set of swing keyframes drives
 * every weapon, so the difference in reach on screen is this number. `drop` is
 * how far down the grip sits in the fist, because a scythe is held at the
 * middle of its shaft and a dagger at the very end of a short one.
 */
const FIT: Record<WeaponModelId, { scale: number; drop: number; yaw?: number }> = {
  sword: { scale: 0.78, drop: -0.15 },
  // Long and heavy: the blade reads at 1.0 and the grip sits deep in the fist,
  // so the pommel does not stick out through the back of the hand. -0.12, not
  // the -0.2 this was for the old long-armed rig: the chibi's hand is a 0.43
  // ball and a pommel 0.25 down the hilt stood 0.032 proud of it. The rule is
  // one comparison — grip end inside the ball's radius — see GRIP_LOCAL_Y in
  // hero-rig.ts, and tools measure it rather than an eye judging it.
  greatsword: { scale: 0.92, drop: -0.12 },
  // A QUARTER TURN, and it is the only `yaw` in the table. Every other weapon
  // here is a blade on a stick and reads from any angle; a bow is a FLAT
  // object, built in its own Y-Z plane, and the hand's rest pose presents that
  // plane edge-on — captured, the hero appeared to be holding a plain staff.
  // Turned, the arc and the string face the camera and it is a bow again.
  bow: { scale: 0.95, drop: -0.02, yaw: Math.PI / 2 },
  // Held at the middle of the shaft — the haft runs both ways from the fist,
  // which is what makes a scythe read as a scythe rather than a bent sword.
  scythe: { scale: 0.9, drop: -0.42 },
  dagger: { scale: 0.62, drop: -0.1 },
};

/** The iron sword: the original, moved here unchanged. */
function buildSword(): VoxelModel {
  const v = new VoxelModel();
  // The hilt is built 3 voxels deep (z -1..1) while the blade stays 1 deep, so
  // pommel / grip / crossguard read as separate chunky parts from any angle
  // instead of the whole weapon looking like one flat plank.
  v.box(0, -1, -1, 1, -1, 1, GOLD); // pommel knob
  v.box(0, 0, -1, 1, 2, 1, GRIP); // leather-wrapped grip
  v.set(0, 1, -1, WRAP);
  v.set(1, 1, 1, WRAP);
  v.box(-1, 3, 0, 2, 3, 0, GOLD); // crossguard
  v.box(0, 3, -1, 1, 3, 1, GOLD);
  v.set(-1, 4, 0, GOLD);
  v.set(2, 4, 0, GOLD);
  for (let y = 4; y <= 8; y++) {
    // stepped blade — see the header
    v.set(0, y, 0, STEEL_L);
    v.set(1, y, 0, STEEL);
    v.set(1, y, 1, STEEL_D);
  }
  v.set(0, 9, 0, STEEL_L);
  v.set(1, 9, 0, STEEL_D);
  v.set(0, 10, 0, STEEL);
  return v;
}

/** Two-handed, wide-shouldered, and squared off at the tip like the icon. */
function buildGreatsword(): VoxelModel {
  const v = new VoxelModel();
  v.box(-1, -3, -1, 1, -2, 1, DARK); // heavy pommel block
  v.box(0, -1, -1, 0, 2, 1, GRIP); // long grip, room for two hands
  v.set(0, 0, -1, WRAP);
  v.set(0, 2, 1, WRAP);
  v.box(-2, 3, -1, 2, 3, 1, STEEL_D); // slab crossguard
  v.set(-2, 4, 0, STEEL_D);
  v.set(2, 4, 0, STEEL_D);
  // Blade: three columns wide, with the middle one raised a voxel in z so the
  // fuller catches the light down the length of it.
  for (let y = 4; y <= 12; y++) {
    v.set(-1, y, 0, STEEL);
    v.set(0, y, 0, STEEL_L);
    v.set(1, y, 0, STEEL);
    v.set(0, y, 1, STEEL_D);
  }
  // Squared tip, chamfered by one voxel each side.
  v.set(0, 13, 0, STEEL_L);
  v.set(-1, 13, 0, STEEL);
  v.set(1, 13, 0, STEEL);
  v.set(0, 14, 0, STEEL);
  return v;
}

/**
 * The bow, held in the fist at its middle with the limbs curving forward.
 *
 * The STRING is a column of its own at z = 2, one voxel wide: without it the
 * silhouette is a wooden C and reads as a horseshoe. The limbs get their depth
 * from the curve rather than from a spine ridge — a bow seen edge-on is still
 * an arc, which is the shape the plank problem is about.
 */
function buildBow(): VoxelModel {
  const v = new VoxelModel();
  // Riser: the grip the hand closes on.
  v.box(0, -1, 0, 0, 1, 1, WOOD_D);
  v.set(0, 0, 1, GRIP);
  // Limbs, curving out in +z as they run away from the grip in y. Symmetric,
  // so it is written once and mirrored through the y sign.
  const limb: [number, number][] = [
    [2, 1],
    [3, 1],
    [4, 2],
    [5, 2],
    [6, 3],
    [7, 3],
    [8, 3],
  ];
  for (const [y, z] of limb) {
    v.set(0, y, z, WOOD);
    v.set(0, -y, z, WOOD);
    v.set(0, y, z - 1, WOOD_D);
    v.set(0, -y, z - 1, WOOD_D);
  }
  // Horn nocks at both tips, where the string ties off.
  v.set(0, 9, 3, HORN);
  v.set(0, -9, 3, HORN);
  // The string, straight between the nocks.
  for (let y = -9; y <= 9; y++) {
    v.set(0, y, 4, HORN);
  }
  return v;
}

/** A long haft with the blade swept off one end, as the icon draws it. */
function buildScythe(): VoxelModel {
  const v = new VoxelModel();
  for (let y = -4; y <= 8; y++) {
    // haft, gripped in the middle
    v.set(0, y, 0, WOOD);
    v.set(0, y, 1, WOOD_D);
  }
  v.box(0, -1, -1, 0, 1, 1, GRIP); // hand wrap
  v.box(0, 4, -1, 0, 4, 1, DARK); // collar ferrule
  v.set(0, -5, 0, DARK); // butt cap
  // The blade: a quarter arc sweeping out in -x from the top of the haft, one
  // bright edge column with a darker body behind it.
  const arc: [number, number][] = [
    [-1, 9],
    [-2, 9],
    [-3, 9],
    [-4, 8],
    [-5, 8],
    [-6, 7],
    [-6, 6],
  ];
  for (const [x, y] of arc) {
    v.set(x, y, 0, STEEL_L);
    v.set(x, y - 1, 0, STEEL);
    v.set(x, y - 1, 1, STEEL_D);
  }
  v.box(0, 9, -1, 0, 9, 1, STEEL_D); // the socket the blade sits in
  return v;
}

/** Short, wide-guarded and quick — the icon's proportions at a smaller scale. */
function buildDagger(): VoxelModel {
  const v = new VoxelModel();
  v.box(0, -1, -1, 0, -1, 1, DARK); // pommel
  v.box(0, 0, -1, 0, 1, 1, GRIP);
  v.set(0, 1, 1, WRAP);
  v.box(-1, 2, 0, 1, 2, 0, STEEL_D); // stubby crossguard
  v.box(0, 2, -1, 0, 2, 1, STEEL_D);
  for (let y = 3; y <= 6; y++) {
    // stepped blade, as above
    v.set(0, y, 0, STEEL_L);
    v.set(0, y, 1, STEEL_D);
  }
  v.set(0, 7, 0, STEEL_L);
  v.set(0, 8, 0, STEEL);
  return v;
}

const BUILDERS: Record<WeaponModelId, () => VoxelModel> = {
  sword: buildSword,
  greatsword: buildGreatsword,
  bow: buildBow,
  scythe: buildScythe,
  dagger: buildDagger,
};

/**
 * Build one weapon's mesh, positioned so the hand grips it at the origin.
 *
 * Callers keep the result and hand it back to `disposeWeapon` — the mount in
 * hero-rig.ts does both, and is the only caller.
 */
export function buildWeaponModel(id: WeaponModelId): THREE.Mesh {
  const fit = FIT[id];
  const mesh = BUILDERS[id]().build(S, true);
  mesh.position.y = fit.drop;
  mesh.scale.setScalar(fit.scale);
  if (fit.yaw) {
    mesh.rotation.y = fit.yaw;
  }
  return mesh;
}

/** Give a weapon's geometry and material back. Materials are per-mesh here. */
export function disposeWeapon(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const m = mesh.material;
  if (Array.isArray(m)) {
    for (const one of m) {
      one.dispose();
    }
  } else {
    m.dispose();
  }
}
