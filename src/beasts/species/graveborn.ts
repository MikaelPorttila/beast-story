import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";

// Graveborn — issue #119. The roster's first BIPED: a bleached skeleton soldier in salvaged
// leather with a chipped iron sword; the walk is a human walk with counter-swinging arms.
// Voxel scale 0.06 — at 0.1 a rib is one fat cell, at 0.045 a limb bone is invisible or a plank.
// Model faces +Z. Root at ground level, ~1.84 to the crown.

const S = 0.06;

// Bone is a WARM off-white, never grey, and warm on the shadow side too: the fill's cool sky
// turns a cool tone olive. The three values are a full stop apart, so a rib separates from
// the spine behind it — on a lattice, that is the entire job.
const C = {
  bone: 0xc4b48c, // sun-bleached bone, the body value
  boneLt: 0xf2e8c6,
  boneDk: 0xa89468,
  boneDp: 0x84703f,
  socket: 0x241f18, // very dark BROWN, not black: black punches a hole in the silhouette
  eye: 0x2ec6ee,
  eyeLt: 0x8fdcf2,
  // Desaturated, or it reads as orange plastic; leatherDk stays above ~0x48 or it crushes.
  leather: 0x6d4a30,
  leatherLt: 0x8a5f3c,
  leatherDk: 0x6a4a2c,
  steel: 0xb0a89c,
  steelLt: 0xe4dfd4,
  steelDk: 0x7a7064,
} as const;

/** Low on purpose: a bloom pass is downstream, and 0.8 left two cyan slabs with no socket. */
const EYE_GLOW = 0.45;

// Shared between buildRig() and animate(): a number in both is a pose that drifts.
const HIP_Y = 0.66; // hip joints, above the root
// 0.88 against a belt topping out at 0.86: the lowest rib ring and the belt shared a plane.
const TORSO_Y = 0.88; // lumbar pivot: the ribcage twists here
const PELVIS_Y = 0.62;
const SHOULDER_Y = 0.44;
// 0.27, level with the clavicle's tip: at 0.21 the arm sat outboard of the ribs and vanished.
const SHOULDER_X = 0.27;
const NECK_Y = 0.56;
const KNEE_Y = -0.24;
const ELBOW_Y = -0.24;

/**
 * Three tenths of a voxel, and it is why this rig is seam-free. A limb is the one place two
 * parts run PARALLEL: a femur and a tibia of the same width with the knee straight put their
 * outer walls on one plane, which test-zfight reports through most of a walk. So the JOINT is
 * offset at hips, knees, shoulders, elbows, neck, jaw, pelvis and hand. NOT a half: an even
 * cell span already carries build()'s own half-cell shift, which a half-cell parting cancels.
 */
const JOINT_PART = S * 0.3;

export const skills: SkillDef[] = [
  {
    id: "graveborn.rusted-cleave",
    nameKey: "skill.graveborn.rusted-cleave.name",
    descriptionKey: "skill.graveborn.rusted-cleave.desc",
    element: "shadow",
    targeting: "melee",
    cost: 5,
    cooldown: 1.4,
    power: 15,
    range: 2.8,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "graveborn.bone-shard",
    nameKey: "skill.graveborn.bone-shard.name",
    descriptionKey: "skill.graveborn.bone-shard.desc",
    element: "shadow",
    targeting: "projectile",
    cost: 13,
    cooldown: 5.5,
    power: 24,
    range: 16,
    learnAtLevel: 5,
    castAnim: "cast",
  },
  {
    id: "graveborn.grave-ward",
    nameKey: "skill.graveborn.grave-ward.name",
    descriptionKey: "skill.graveborn.grave-ward.desc",
    element: "shadow",
    targeting: "aoe",
    cost: 17,
    cooldown: 8,
    power: 28,
    range: 5,
    storePrice: 250,
    castAnim: "special",
  },
  {
    id: "graveborn.last-rites",
    nameKey: "skill.graveborn.last-rites.name",
    descriptionKey: "skill.graveborn.last-rites.desc",
    element: "shadow",
    targeting: "beam",
    cost: 25,
    cooldown: 12,
    power: 46,
    range: 13,
    storePrice: 400,
    castAnim: "special",
  },
];

// EVERY PART'S CELL SPAN IS SYMMETRIC IN X: `build(center = true)` re-bases on the bounding box,
// so a lopsided span lands half a cell off its group's origin and a pair visibly drifts.

/**
 * One rib: the SHELL of an ellipse in the x/z plane. A shell test rather than a hand-listed
 * staircase, because it is face-connected by construction — diagonals bake as loose cubes. The
 * back arc takes the DEEPEST tone, or both halves of the loop merge into a barrel.
 */
function ribRing(v: VoxelModel, y: number, w: number, d: number): void {
  const inside = (x: number, z: number): boolean => (x / w) ** 2 + (z / d) ** 2 <= 1;
  for (let x = -w; x <= w; x++) {
    for (let z = -d; z <= d; z++) {
      if (!inside(x, z)) {
        continue;
      }
      const shell =
        !inside(x + 1, z) || !inside(x - 1, z) || !inside(x, z + 1) || !inside(x, z - 1);
      if (!shell) {
        continue;
      }
      // ONE row of drop into the sternum: at one constant y the front view is a radiator, and
      // two rows lands on the ring below and fills in the gap.
      const drop = z === d && Math.abs(x) <= 1 ? 1 : 0;
      v.set(x, y - drop, z, z >= d ? C.boneLt : z < 0 ? C.boneDp : C.bone);
    }
  }
}

/**
 * A closed band of leather. A band is a RING, so the bone has to run THROUGH its rows: at the
 * height of a gap it is cells joined only at their diagonals, which bakes as a floating hoop.
 */
function strap(v: VoxelModel, y: number, w: number, d: number, rows = 2): void {
  for (let r = 0; r < rows; r++) {
    for (let x = -w; x <= w; x++) {
      for (let z = -d; z <= d; z++) {
        if (Math.abs(x) < w && Math.abs(z) < d) {
          continue;
        } // a band, not a block
        v.set(x, y + r, z, r === rows - 1 ? C.leatherLt : C.leather);
      }
    }
  }
}

/**
 * The skull. Seven cells wide so the grid is symmetric about x = 0 — eyes2x2 mirrors the
 * caller's right-hand geometry and cannot do that on an even width. THREE TONES ON THE FACE:
 * lids, zygomatics and alternating teeth together read as a corrupted texture. The stepped
 * crown, narrower maxilla and proud teeth carry the silhouette.
 */
function buildSkull(): THREE.Mesh {
  const v = new VoxelModel();
  for (let y = 1; y <= 6; y++) {
    const inset = y === 6 ? 1 : 0; // stepped crown
    v.box(-3 + inset, y, -3 + inset, 3 - inset, y, 3 - inset, C.bone);
  }
  v.box(-2, 0, -2, 2, 0, 3, C.bone); // maxilla, narrower and shallower
  // One row each: given the whole y range they repaint a FRONT face as often as a top one.
  rimTop(v, C.boneLt, -3, 3, 6, 6, -3, 3);
  shadeUnder(v, C.boneDk, -3, 3, 0, 0, -3, 3);

  // Socket recess FIRST, and the ratio is the read: two cells by three with ONE glowing column
  // inside. An iris that fills its socket leaves no dark around the glow — ski goggles.
  for (const sx of [1, -1]) {
    for (let y = 3; y <= 5; y++) {
      v.set(sx * 2, y, 3, C.socket);
      v.set(sx * 3, y, 3, C.socket);
    }
  }
  // No `bridge`: it fills the WHOLE gap and would paint over the dark cell inboard of each
  // socket. `lid` takes the socket tone, since a half-value coat row is for a muzzle.
  eyes2x2(v, {
    inner: 2,
    width: 1,
    y: 4,
    faceZ: 3,
    iris: C.eye,
    glow: EYE_GLOW,
    shine: C.eyeLt,
  });
  // THREE cells between the sockets: one cell is sub-pixel and the holes bridge into one band.
  for (let y = 3; y <= 5; y++) {
    v.box(-1, y, 3, 1, y, 3, C.boneLt);
  }
  v.set(0, 4, 4, C.boneLt);
  v.set(0, 5, 4, C.boneLt);
  for (let x = -2; x <= 2; x++) {
    v.set(x, 6, 3, C.boneDk);
    v.set(x, 6, 4, C.boneDk);
  }
  v.set(0, 2, 3, C.socket);
  v.set(0, 1, 3, C.socket);
  v.set(-1, 1, 3, C.socket);
  v.set(1, 1, 3, C.socket);
  v.set(-3, 2, 3, C.boneDk);
  v.set(3, 2, 3, C.boneDk);
  // Teeth hung IN a cut gap: flush on a pale face they were invisible in both directions.
  for (let x = -2; x <= 2; x++) {
    v.set(x, 0, 3, C.socket);
    if (x % 2 === 0) {
      v.set(x, 0, 4, C.boneLt);
    }
  }
  return v.build(S, true);
}

/**
 * The mandible, on its own hinge. ONE ROW: the upper jaw is already a row of the skull, and at
 * two the mandible's underside landed flush on the clavicle's.
 */
function buildJaw(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-2, 0, -2, 2, 0, 3, C.bone);
  for (let x = -2; x <= 2; x++) {
    v.set(x, 0, 3, C.boneDp);
  } // mouth line, front face only
  return v.build(S, true);
}

/**
 * Spine, ribcage, clavicle and neck as one mesh: none of them move relative to each other. THE
 * CLAVICLE IS THE WIDEST THING ON THE BODY — at the cage's width the arms were invisible.
 */
function buildRibcage(): THREE.Mesh {
  const v = new VoxelModel();
  for (let y = 0; y <= 6; y++) {
    v.set(0, y, -2, C.boneDk);
  } // spine, up the back

  ribRing(v, 6, 3, 2);
  ribRing(v, 4, 3, 2);
  ribRing(v, 2, 3, 2);
  ribRing(v, 0, 2, 2);

  // Sternum joins the rings' front ends; it stops at row 1, where the chevron drops away.
  for (let y = 1; y <= 6; y++) {
    v.set(0, y, 2, C.boneLt);
  }

  v.box(-4, 7, 1, 4, 7, 1, C.bone);
  v.box(-1, 7, 0, 1, 7, 0, C.boneLt);
  v.set(4, 7, 1, C.boneLt);
  v.set(-4, 7, 1, C.boneLt);
  v.set(3, 7, 1, C.boneDk);
  v.set(-3, 7, 1, C.boneDk);
  v.box(-3, 7, -2, 3, 7, -2, C.boneDk);

  // TWO vertebrae, THREE wide: the column must be continuous from clavicle to jaw at any pitch.
  for (let y = 8; y <= 9; y++) {
    v.box(-1, y, 0, 1, y, 0, C.bone);
    v.box(-1, y, -1, 1, y, -1, C.boneDk);
  }
  return v.build(S, true);
}

/** The lowest cell `buildPelvis` paints — the longest tongue of the skirt. */
const HEM = -7;

/**
 * Pelvis, belt, buckle and skirt as ONE voxel grid: a skirt can only hang where the pelvis
 * already is, so as its own mesh some wall always landed on the belt's or the ilium's. FRONT
 * AND BACK PANELS ONLY — a closed cone hides the femurs, and the femurs are the point.
 */
function buildPelvis(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-3, 0, -1, 3, 1, 1, C.bone);
  v.set(3, 0, 0, C.boneDp);
  v.set(-3, 0, 0, C.boneDp);
  rimTop(v, C.boneLt, -3, 3, 1, 1, -1, 1);

  // Panels hang at the BELT's own depth, five columns not seven (at seven they covered the
  // femurs), and the NOTCH is the point of the numbers: a monotonic hem was cut with shears.
  const front = [4, 8, 4, 7, 2];
  const back = [3, 6, 5, 3, 1];
  for (let i = 0; i < 5; i++) {
    const x = i - 2;
    for (let d = 0; d < front[i]; d++) {
      v.set(x, 1 - d, 2, d === front[i] - 1 ? C.leatherDk : C.leather);
    }
    for (let d = 0; d < back[i]; d++) {
      v.set(x, 1 - d, -2, d === back[i] - 1 ? C.leatherDk : C.leather);
    }
  }

  strap(v, 2, 3, 2);
  // Buckle fitted INSIDE the belt's rows, one cell of steelLt: brighter and the eye lands on it.
  for (const y of [2, 3]) {
    v.set(-1, y, 3, C.steel);
    v.set(1, y, 3, C.steel);
  }
  v.set(0, 3, 3, C.steel);
  v.set(0, 2, 3, C.steelLt);
  for (const x of [-1, 1]) {
    v.set(x, 3, -2, C.steel);
  }

  const m = v.build(S, true);
  // build() zeroes y on the LOWEST cell, the hem, so the hem's depth is the offset.
  m.position.y = HEM * S;
  return m;
}

/**
 * The femur, TWO cells square. One was the reference's literal proportion and the wrong
 * measurement to copy: a 6 cm bone against chunky trees at twenty metres is a thread.
 */
function buildThigh(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(0, 0, 0, 1, 3, 1, C.bone);
  v.box(0, 3, 0, 1, 3, 0, C.boneLt);
  v.box(0, 0, 1, 1, 0, 1, C.boneDk);
  const m = v.build(S, true);
  m.position.y = -4 * S;
  return m;
}

/** Shin, ankle and foot, with one leather band at each end of the bone. */
function buildShin(): THREE.Mesh {
  const v = new VoxelModel();
  // The tibia runs THROUGH both bands' rows — see strap(); a row short left a floating hoop.
  v.box(0, 1, 0, 1, 6, 1, C.bone);
  v.box(0, 6, 0, 1, 6, 0, C.boneLt);
  v.box(-1, 0, -1, 2, 0, 2, C.bone);
  v.box(-1, 1, 2, 2, 1, 2, C.bone);
  v.set(0, 1, 2, C.boneDp);
  v.set(0, 0, 2, C.boneDp);
  v.box(-1, 0, -1, 2, 0, -1, C.boneDk);
  strap(v, 1, 1, 1, 1);
  strap(v, 6, 1, 1, 1);
  const m = v.build(S, true);
  m.position.y = -7 * S;
  return m;
}

/**
 * Upper arm. Only the rivet uses `dir`, and it stays INSIDE the pauldron's span so the
 * bounding box is symmetric either way.
 */
function buildUpperArm(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  // TWO cells wide: this arm ends in a three-cell fist, and a one-cell wire with a brick on the
  // end reads as a detached glove. The box runs a row PAST the elbow pivot, so humerus and
  // forearm overlap through the swing instead of showing daylight at every bend.
  const x0 = dir > 0 ? 0 : -1;
  v.box(x0, -1, 0, x0 + 1, 3, 1, C.bone);
  v.box(x0, 3, 0, x0 + 1, 3, 0, C.boneLt);
  // Pauldron FIVE across but two rows tall and STEPPED: narrower it matched the bracer and the
  // upper body read as bandaging; wider in every axis it was a slab bigger than the skull.
  v.box(-2, 2, -1, 2, 2, 1, C.leather);
  v.box(-1, 3, -1, 1, 3, 1, C.leatherLt);
  shadeUnder(v, C.leatherDk, -2, 2, 2, 2, -1, 1);
  for (const x of [dir, dir * 2]) {
    v.set(x, 2, 1, C.steel);
  }
  v.set(dir * 2, 3, 1, C.steel);
  v.set(dir, 3, 1, C.steelDk);
  const m = v.build(S, true);
  // -3, so the pauldron's top row lands ON the pivot: higher, it stands level with the jaw.
  m.position.y = -3 * S;
  return m;
}

/** Forearm, leather bracer and the hand. */
function buildForearm(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const x0 = dir > 0 ? 0 : -1;
  v.box(x0, 4, 0, x0 + 1, 6, 1, C.bone);
  strap(v, 5, 1, 1, 1);
  // The FIST is deliberately big: a two-row palm vanished, leaving an arm that stopped in a band.
  v.box(-1, 1, 0, 1, 3, 1, C.bone);
  rimTop(v, C.boneLt, -1, 1, 3, 3, 0, 1);
  for (const x of [-1, 0, 1]) {
    v.set(x, 0, 1, C.boneDp);
    v.set(x, 2, 2, x === 0 ? C.boneDp : C.bone);
  }
  v.set(-dir, 2, 0, C.boneDp);
  const m = v.build(S, true);
  m.position.y = -7 * S;
  return m;
}

/**
 * The sword, built here rather than borrowed from `player/weapons.ts`: those are the HERO's kit
 * at his own scale. Grip at the origin, blade up +Y — weapons.ts's convention — and the length
 * stops at mid-shin, because from a fist at 0.72 a blade reaching the sole reads as a crutch.
 */
function buildSword(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-1, -2, 0, 1, -2, 1, C.steelDk);
  v.box(0, -1, 0, 0, 0, 1, C.leatherDk);
  v.set(0, 0, 1, C.leather);
  v.box(-3, 1, 0, 3, 1, 1, C.steel);
  v.set(-3, 2, 0, C.steelDk);
  v.set(3, 2, 0, C.steelDk);
  // Blade three cells wide, and the lit column is the OUTBOARD EDGE: down the middle it reads
  // as a stripe painted on a rectangle.
  for (let y = 2; y <= 9; y++) {
    const h = y <= 8 ? 1 : 0;
    for (let x = -h; x <= h; x++) {
      v.set(x, y, 0, x === h ? C.steelLt : C.steel);
    }
    v.set(0, y, 1, C.steelDk);
  }
  v.set(-1, 4, 0, C.steelDk);
  v.set(1, 6, 0, C.steelDk);
  v.set(-1, 8, 0, C.steelDk);
  v.set(1, 7, 0, C.steelDk);
  const m = v.build(S, true);
  // build() zeroes y on the pommel, two rows below the grip, so two rows restores the GRIP.
  m.position.y = -2 * S;
  return m;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  root.add(body);
  parts.body = body;

  for (const side of [1, -1]) {
    const hip = new THREE.Group();
    // 2.5 cells out is the ilium's edge, and TWICE the parting in z because the pelvis steps
    // the same way and one step would cancel.
    hip.position.set(side * 2.5 * S, HIP_Y, 2 * JOINT_PART);
    hip.add(buildThigh());
    body.add(hip);
    const knee = new THREE.Group();
    // The parting ACCUMULATES: the same way again, or the two cancel.
    knee.position.set(side * JOINT_PART, KNEE_Y, JOINT_PART);
    knee.add(buildShin());
    hip.add(knee);
    parts[side > 0 ? "hipR" : "hipL"] = hip;
    parts[side > 0 ? "kneeR" : "kneeL"] = knee;
  }

  const pelvis = new THREE.Group();
  // Parted in z: belt and thoracic spine share the cage's back plane.
  pelvis.position.set(0, PELVIS_Y, JOINT_PART);
  pelvis.add(buildPelvis());
  body.add(pelvis);
  parts.pelvis = pelvis;

  const torso = new THREE.Group();
  torso.position.y = TORSO_Y;
  torso.add(buildRibcage());
  body.add(torso);
  parts.torso = torso;

  const head = new THREE.Group();
  // Parted in z only: an x parting put the head off the centreline, which shows on a pair.
  head.position.set(0, NECK_Y, JOINT_PART);
  head.add(buildSkull());
  torso.add(head);
  parts.head = head;

  const jaw = new THREE.Group();
  // The jaw takes the parting, not the skull: it SWINGS through both neighbouring planes.
  jaw.position.set(JOINT_PART, -S, -JOINT_PART);
  jaw.add(buildJaw());
  head.add(jaw);
  parts.jaw = jaw;

  for (const side of [1, -1]) {
    const shoulder = new THREE.Group();
    // Parted BACKWARD where the neck is parted forward, so pauldron and jaw cannot agree.
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, -JOINT_PART);
    shoulder.add(buildUpperArm(side));
    torso.add(shoulder);
    const elbow = new THREE.Group();
    // INBOARD: outboard, the forearm's inner wall landed on the belt's as the arm passed the hip.
    elbow.position.set(-side * JOINT_PART, ELBOW_Y, JOINT_PART);
    elbow.add(buildForearm(side));
    shoulder.add(elbow);
    parts[side > 0 ? "shoulderR" : "shoulderL"] = shoulder;
    parts[side > 0 ? "elbowR" : "elbowL"] = elbow;
  }

  const hand = new THREE.Group();
  // Own group, so a pose can angle the blade without the wrist; parted in x from the forearm and
  // carried FORWARD so the crossguard sits in front of the thigh.
  hand.position.set(-JOINT_PART, -6 * S, S * 1.5);
  // The REST pose is stated HERE because test-zfight builds rigs and never animates them: an
  // unrotated sword parked its flats on the forearm's and the pauldron's planes.
  hand.rotation.set(3.0, 0.55, -0.1);
  hand.add(buildSword());
  parts.elbowR.add(hand);
  parts.hand = hand;

  return { root, parts, height: 1.84, radius: 0.3 };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

/** Integrated cycle slot — see BeastAnimCtx.cycle(). One gait is all a walking skeleton needs;
 *  the sway and the jaw run off the free clock at fixed rates. */
const GAIT = 0;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  let bodyX = 0;
  let bodyY = 0;
  let bodyZ = 0;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = 0;
  let torsoRY = Math.sin(t * 0.6) * 0.05;
  let torsoRX = 0;
  let headRX = Math.sin(t * 0.8) * 0.05 + 0.04;
  let headRY = Math.sin(t * 0.4) * 0.3;
  let headRZ = Math.sin(t * 0.55) * 0.04;
  let jawOpen = 0.06 + Math.sin(t * 1.4) * 0.03;
  // A skeleton does not breathe, so the idle is a slow weight shift; it drives the roll and the
  // knees, so the leg carrying the weight is the straight one.
  const shift = Math.sin(t * 0.7);
  bodyRZ = shift * 0.025;
  bodyY = -Math.abs(shift) * 0.008;
  let hipRXR = -0.04 + shift * 0.05;
  let hipRXL = -0.04 - shift * 0.05;
  let kneeRXR = 0.1 - shift * 0.06;
  let kneeRXL = 0.1 + shift * 0.06;
  let hipSplit = 0.05;
  let shRXR = 0.05 + Math.sin(t * 0.7) * 0.03;
  let shRXL = 0.05 - Math.sin(t * 0.7) * 0.03;
  // The sword arm gets its OWN split: the blade hung in the right shin's column and the
  // character read as three-legged. The GRIP has to move outboard, which is the shoulder's job.
  let shSplitR = 0.2;
  let shSplitL = 0.12;
  let elRXR = -0.1;
  let elRXL = -0.22;
  // Rest: the hand group's +Y is the blade's own axis, so hanging is near pi, not the 2.35 that
  // stood it out like an oar. The yaw keeps the flat off square to the camera.
  let handRX = 3.0;
  let handRY = 0.55;
  let handRZ = -0.1;

  switch (ctx.action) {
    case "walk":
    case "run":
    case "fly":
    case "swim": {
      const k = 0.5 + 0.5 * ctx.moveSpeed;
      // 4.4 rad/s at a trudge to 8.4 flat out — a human cadence, marching rather than scurrying.
      const w = ctx.cycle(GAIT, 4.4 + 4.0 * ctx.moveSpeed);
      const sw = Math.sin(w);
      const swB = Math.sin(w + Math.PI);
      // 0.85, not 0.55: on a 0.42-long shin the foot travelled less than its own length per stride.
      hipRXR = sw * (0.85 * k);
      hipRXL = swB * (0.85 * k);
      // The knee bends only on the RETURN half, or the walk is a pair of scissors.
      kneeRXR = 0.1 + Math.max(0, -sw) * (0.8 * k);
      kneeRXL = 0.1 + Math.max(0, -swB) * (0.8 * k);
      hipSplit = 0.04;
      bodyY = -0.02 * k + Math.abs(Math.sin(w)) * 0.05 * k;
      bodyRZ = Math.sin(w) * 0.05 * k;
      bodyRX = 0.1 * k;
      torsoRY = -sw * 0.2 * k;
      torsoRX = 0.05 * k;
      headRX = -0.1 * k + Math.sin(w * 2) * 0.03;
      headRY = Math.sin(t * 0.9) * 0.08;
      headRZ = sw * 0.05;
      jawOpen = 0.05;
      shRXR = swB * (0.32 * k);
      shRXL = sw * (0.48 * k);
      shSplitR = 0.18; // the sword arm stays out, or the blade walks through the shin
      shSplitL = 0.08;
      elRXR = -0.45 - Math.max(0, swB) * 0.25;
      elRXL = -0.3 - Math.max(0, sw) * 0.5;
      handRX = 2.95;
      handRY = 0.5;
      handRZ = -0.1;
      break;
    }
    case "attack": {
      // The wind-up is the frame a cleave is READ from: at 0.20s it existed for a fifth of a
      // second and captures came back showing the sword at the hip. 0.32 up, 0.12 held, 0.10 cut.
      const wind = easeOutCubic(clamp01(at / 0.32));
      const swing = easeOutCubic(clamp01((at - 0.44) / 0.1));
      const rec = easeInOutSine(clamp01((at - 0.56) / 0.34));
      const cut = swing * (1 - rec);
      const coil = wind * (1 - swing);
      bodyRX = -0.18 * coil + 0.42 * cut;
      bodyZ = -0.05 * coil + 0.2 * cut;
      bodyY = 0.03 * coil - 0.05 * cut;
      torsoRY = 0.55 * coil - 0.7 * cut;
      torsoRX = -0.2 * coil + 0.35 * cut;
      headRX = -0.2 * coil + 0.32 * cut;
      headRY = 0.25 * coil - 0.2 * cut;
      jawOpen = 0.15 * coil + 0.55 * swing * (1 - rec);
      // -2.05, not -2.70, which puts the blade a body-length BEHIND the beast, out of shot.
      shRXR = -2.05 * coil - 0.3 + 1.75 * cut;
      shRXL = 0.4 * coil - 0.55 * cut;
      // The split is CUT on the wind-up: raised, the arm opens a visible gap at the shoulder.
      shSplitR = 0.14 + 0.1 * coil;
      shSplitL = 0.14 + 0.1 * coil;
      elRXR = -0.75 * coil - 0.2 + 0.85 * cut;
      elRXL = -0.6;
      // THE WRIST IS SOLVED, not keyframed: shoulder and elbow swing through three radians, so a
      // fixed angle aims the blade differently at every instant. State the BLADE, subtract the arm.
      const bladeAngle = 3.05 - 2.8 * coil - 5.3 * cut;
      handRX = bladeAngle - (shRXR + elRXR);
      handRY = -0.55 * coil + 0.7 * cut;
      handRZ = -0.55 * coil + 0.35 * cut;
      hipRXR = 0.18 * coil - 0.3 * cut;
      hipRXL = -0.22 * coil + 0.34 * cut;
      kneeRXR = 0.3 * coil + 0.15 * cut;
      kneeRXL = 0.1 + 0.3 * cut;
      hipSplit = 0.16;
      break;
    }
    case "cast": {
      const gather = easeInOutSine(clamp01(at / 0.34));
      const throwT = easeOutCubic(clamp01((at - 0.5) / 0.14));
      const settle = easeInOutSine(clamp01((at - 0.7) / 0.3));
      const g = gather * (1 - throwT);
      const f = throwT * (1 - settle);
      bodyRX = -0.2 * g + 0.24 * f;
      bodyY = 0.03 * g;
      torsoRY = -0.35 * g + 0.4 * f;
      torsoRX = -0.12 * g + 0.18 * f;
      headRX = -0.24 * g + 0.18 * f;
      headRY = -0.18 * g;
      jawOpen = 0.1 * g + 0.45 * f;
      shRXL = -1.55 * g - 0.1 - 1.05 * f;
      elRXL = -1.7 * g - 0.15 + 1.55 * f;
      shRXR = 0.3 * g + 0.1;
      elRXR = -0.35;
      shSplitR = 0.18;
      shSplitL = 0.18;
      handRX = 3.08;
      handRY = 0.5;
      hipRXR = -0.14 * g;
      hipRXL = 0.1 * g;
      kneeRXR = 0.22 + 0.18 * g;
      kneeRXL = 0.22 + 0.18 * g;
      hipSplit = 0.14;
      break;
    }
    case "special": {
      const rise = easeOutCubic(clamp01(at / 0.32));
      const fall = easeInOutSine(clamp01((at - 0.9) / 0.36));
      const amp = rise * (1 - fall);
      const tremor = Math.sin(t * 22) * 0.02 * amp;
      bodyRX = -0.26 * amp;
      bodyY = 0.05 * amp + tremor;
      torsoRX = -0.24 * amp;
      torsoRY = Math.sin(t * 5) * 0.05 * amp;
      headRX = -0.55 * amp;
      headRY = 0;
      headRZ = tremor * 2;
      jawOpen = 0.85 * amp;
      shRXR = -2.75 * amp + 0.06;
      elRXR = -0.1 * amp - 0.2;
      shRXL = -1.15 * amp + 0.06;
      elRXL = -0.85 * amp - 0.2;
      shSplitR = 0.1 + 0.35 * amp;
      shSplitL = 0.1 + 0.35 * amp;
      handRX = 0.1 * amp;
      handRY = 0.15;
      hipRXR = -0.18 * amp;
      hipRXL = -0.18 * amp;
      kneeRXR = 0.3 * amp + 0.08;
      kneeRXL = 0.3 * amp + 0.08;
      hipSplit = 0.22 * amp + 0.05;
      break;
    }
    case "hurt": {
      // A skeleton takes a hit by RATTLING: higher frequency, lower amplitude than flesh.
      const d = Math.max(0, 1 - at / 0.5);
      bodyX = Math.sin(at * 58) * 0.03 * d;
      bodyRZ = Math.sin(at * 50) * 0.1 * d;
      bodyRX = -0.22 * d;
      bodyZ = -0.06 * d;
      torsoRY = Math.sin(at * 46) * 0.16 * d;
      torsoRX = 0.18 * d;
      headRX = 0.3 * d;
      headRZ = Math.sin(at * 54) * 0.14 * d;
      jawOpen = 0.35 * d + 0.05;
      shRXR = 0.55 * d + 0.06;
      shRXL = 0.6 * d + 0.06;
      shSplitR = 0.3 * d + 0.1;
      shSplitL = 0.3 * d + 0.1;
      elRXR = -0.75 * d - 0.2;
      elRXL = -0.75 * d - 0.2;
      handRX = 3.05 + 0.3 * d;
      hipRXR = 0.24 * d;
      hipRXL = 0.16 * d;
      kneeRXR = 0.42 * d + 0.1;
      kneeRXL = 0.34 * d + 0.1;
      hipSplit = 0.14 * d + 0.05;
      break;
    }
    case "happy": {
      const hop = Math.abs(Math.sin(at * 6.0));
      bodyY = hop * 0.09;
      bodyRY = Math.sin(at * 3.0) * 0.35;
      bodyRZ = Math.sin(at * 6.0) * 0.07;
      torsoRY = Math.sin(at * 3.0) * 0.18;
      headRX = -0.14;
      headRZ = Math.sin(at * 6.0) * 0.16;
      headRY = Math.sin(at * 3.0) * 0.2;
      jawOpen = 0.3 + Math.sin(at * 12) * 0.2;
      shRXR = -1.1 - Math.sin(at * 6.0) * 0.55;
      elRXR = -0.55;
      shRXL = -0.35 + Math.sin(at * 6.0) * 0.55;
      elRXL = -0.75;
      shSplitR = 0.28;
      shSplitL = 0.28;
      handRX = 0.35;
      handRY = 0.2;
      hipRXR = Math.sin(at * 6.0) * 0.34;
      hipRXL = Math.sin(at * 6.0 + Math.PI) * 0.34;
      kneeRXR = 0.15 + Math.max(0, -Math.sin(at * 6.0)) * 0.85;
      kneeRXL = 0.15 + Math.max(0, Math.sin(at * 6.0)) * 0.85;
      hipSplit = 0.08;
      break;
    }
    case "idle":
    default:
      break;
  }

  const body = p.body;
  body.position.set(bodyX, bodyY, bodyZ);
  body.rotation.set(bodyRX, bodyRY, bodyRZ);

  p.torso.rotation.set(torsoRX, torsoRY, 0);
  p.head.rotation.set(headRX, headRY, headRZ);
  p.jaw.rotation.x = jawOpen;

  // The SIGN of a split cost a capture round: a limb hangs along its own -Y, so POSITIVE z swings
  // toward +x, and the right side is at +x. The symmetric-looking version folds both arms in.
  p.hipR.rotation.set(hipRXR, 0, hipSplit);
  p.hipL.rotation.set(hipRXL, 0, -hipSplit);
  p.kneeR.rotation.x = kneeRXR;
  p.kneeL.rotation.x = kneeRXL;

  p.shoulderR.rotation.set(shRXR, 0, shSplitR); // see the note on hipSplit
  p.shoulderL.rotation.set(shRXL, 0, -shSplitL);
  p.elbowR.rotation.x = elRXR;
  p.elbowL.rotation.x = elRXL;

  p.hand.rotation.set(handRX, handRY, handRZ);
}

export const species: BeastSpecies = {
  id: "graveborn",
  nameKey: "beast.graveborn.name",
  element: "shadow",
  locomotion: "ground",
  descriptionKey: "beast.graveborn.desc",
  baseStats: { maxHp: 52, attack: 16, defense: 11, speed: 5.0 },
  skills: [
    "graveborn.rusted-cleave",
    "graveborn.bone-shard",
    "graveborn.grave-ward",
    "graveborn.last-rites",
  ],
  buildRig,
  animate,
};
