import * as THREE from "three";
import { VoxelModel } from "../core/voxel";
import { buildWeaponModel, disposeWeapon, type WeaponModelId } from "./weapons";
import { buildHair, hairStyle, storedHairColour, storedHairStyle } from "./hair";

/**
 * Voxel hero: a chibi adventurer, 1.71 units tall (measured, not declared).
 *
 * NO ARMS AND NO LEGS — only hands and boots, floating free where a limb would
 * be, and no neck: the head sits straight down into the torso. What is left
 * between them is one merged block of hip and thigh. The proportions are the
 * ones authored in Blender (models/chibi_base.py): a head 46% of the figure,
 * over a torso two thirds its width.
 *
 * The pivots are unchanged, which is why the animator did not have to be
 * rewritten: `armL`/`armR` are still shoulders and `legL`/`legR` still hips —
 * a mitt hanging under a shoulder swings on the same rotation an arm did.
 *
 * WHICH SIDE IS WHICH: the hero faces +Z (`Player.forward` is
 * `(sin yaw, 0, cos yaw)`, and the root's own rotation is that yaw), so in a
 * right-handed space with +Y up his RIGHT hand is at NEGATIVE x. The rig used
 * to put `armR` at +x, which made every "right" in this file and in the
 * animator his left — the sword was in his left hand for as long as he has had
 * one. The names now match the body, and a tool asserts it rather than a
 * reader trusting it (see the hand check in the PR).
 *
 *   root (player position, yaw)
 *    └ body (bob / lean / squash)
 *       ├ hips              (the merged leg block, its own small swing)
 *       ├ legL, legR        (hip pivots; a free-floating boot hangs under each)
 *       └ torso (twist)
 *          ├ head           (sunk into the torso, no neck)
 *          ├ armR (+weapon) (his right: -x. Shoulder pivot, mitt hanging under)
 *          └ armL           (his left: +x. The bow moves the weapon here)
 */
export interface HeroRig {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  /** The mount one hairstyle mesh hangs in. See `setHairStyle`. */
  hair: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** The merged hip-and-thigh block; rotates a little against the boots. */
  hips: THREE.Group;
  /**
   * THE HAND, not a sword — the mount a weapon model hangs in. Named for what
   * it held when there was only one thing to hold; see `setWeaponModel`.
   */
  sword: THREE.Group;
  /**
   * Where a weapon rides when it is not in the hand: flat on the back, hilt up
   * over the RIGHT shoulder, so the draw is the hand's own short reach. The
   * hand mount moves into this group and back out — see `stowWeapon`.
   */
  holster: THREE.Group;
  /** True while the weapon is on the back rather than in the hand. */
  stowed: boolean;
  /** The empty sheath on the hip; hidden while the weapon is on his back. */
  scabbard: THREE.Group;
  /** every material in the rig, for damage flash */
  materials: THREE.MeshStandardMaterial[];
  /** What is in the hand right now, or null for bare hands. */
  weapon: WeaponModelId | null;
  /** Which hairstyle is on his head — an id from `HAIR_STYLES`. */
  hairStyle: string;
  /** The colour it is drawn in, resolved: never the "no choice made" null. */
  hairColour: number;
}

// -- palette ---------------------------------------------------------------
const SKIN = 0xf6c69a;
const SKIN_EAR = 0xefb684;
const BLUSH = 0xf59f7d;
const MOUTH = 0xa9603f;
const EYE = 0x2c2833;
const GLINT = 0xffffff;
const STRAP = 0xc9a24f; // gold-tan backpack straps
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
const STEEL_D = 0x76858f;
const GOLD = 0xe6a93c;
const POUCH = 0x8a6238;

const S = 0.1; // voxel scale: 1 voxel = 0.1 m

/**
 * The stack, in world units off the hero's feet. Every part OVERLAPS the one
 * below rather than meeting it flush: a seam two parts share exactly is a
 * coplanar face pair, which is what `test-zfight` fails on, and sinking one
 * into the other also means no gap opens when a joint turns.
 *
 *   boots  0.00 - 0.20   free-floating, 0.04 clear of the block above
 *   hips   0.24 - 0.54   merged block, its top buried in the torso
 *   torso  0.50 - 1.00
 *   head   0.93 - 1.71   sunk into the torso, so a head turn never shows a neck
 *
 * Widths differ for the same reason: the hip block is 0.9 across against the
 * torso's 0.8, so their side faces cannot land on the same plane.
 */
const HIP_Y = 0.44; // hip pivot, high in the block like the Blender rig
const HIPS_DROP = -0.2; // block base, relative to that pivot
const BOOT_DROP = -0.44; // boot sole, relative to the same pivot
const BOOT_X = 0.21;
const TORSO_Y = 0.5;
/**
 * Shoulder height inside the torso. High, at the collar: the hand hangs from it
 * with no arm, and a low pivot put the mitt — and everything it holds — so far
 * down that a sword's tip finished under the ground (measured: the blade hung
 * to y -0.16 at 0.36, against the old rig's +0.04).
 */
const SHOULDER_LOCAL_Y = 0.54;
/**
 * Mitt pivot. 0.66 puts the hand's inner face at 0.445, clear of the torso's own
 * 0.40 half-width — at 0.54 the ball overlapped the tunic and the hand read as
 * attached to it, which is the one thing this silhouette is not.
 */
const SHOULDER_X = 0.66;
const MITT_DROP = -0.46; // hand hangs below the shoulder, so rotation.x swings it
const NECK_LOCAL_Y = 0.46;
/** Ball size, derived: five cells of 0.1, scaled. */
const MITT_SCALE = 0.86; // -> a 0.43 hand on a 1.71 body
const MITT_D = 5 * S * MITT_SCALE; // 0.43 across
const MITT_R = MITT_D / 2;
/**
 * The grip sits at the CENTRE OF THE BALL, not at an offset from it. A mount
 * placed off-centre puts the pommel through the side of the fist, and the
 * amount it sticks out is then a number nobody can derive — measured with
 * tools, the sword's pommel stood 0.023 proud of the hand and a greatsword's
 * 0.096. Centred, everything shorter than the ball's radius is inside it, and
 * what a weapon must satisfy is one comparison instead of four constants.
 */
const GRIP_LOCAL_Y = MITT_DROP + MITT_R;
/**
 * The back carry: hilt at the RIGHT shoulder, blade down across the back to the
 * left hip. 45 degrees is the ask and it has a reason — that diagonal is the
 * one a right hand can reach over its own shoulder and draw from.
 *
 * The mount sits at the GRIP, so the holster goes where the hilt goes and the
 * blade hangs off it: -3PI/4 turns the model's own +Y (up the blade) down and
 * to the hero's left (+x), leaving the hilt up at his right shoulder (-x). Torso-local, so the whole carry turns with the shoulders and
 * not with the hips.
 *
 * NO TILT, and the hilt sits at hand height rather than at the shoulder. Both
 * are the big head's doing: it overhangs the back by 0.23 — further back than
 * the tunic itself — so a hilt up at the shoulder is a hilt inside the hair,
 * and any tilt swings the blade's far end through the body instead of laying it
 * on the back. At y 0.22 the grip is level with the resting hand, which is the
 * reach the 45 degrees exists for.
 */
const HOLSTER_POS = { x: 0, y: 0.22, z: -0.27 };
const HOLSTER_ANGLE = (-3 * Math.PI) / 4;
/**
 * The vertical run a stowed weapon has to fit inside. The floor is the ground:
 * a blade through the turf is the one thing here nobody can miss. The head is
 * NOT a ceiling — it overhangs the back by 0.23, so a hilt that reaches up
 * behind it is inside it and hidden by the hair, which is untidy but invisible;
 * the alternative is laying every weapon nearly flat and losing the 45.
 */
const HOLSTER_BAND = 1.0;
/**
 * Head height 0.78 of the figure's 1.74 — 45%, the chibi ratio, against the
 * 0.63 (36%) this rig carried when it had arms and legs to balance.
 */
const HEAD_SCALE = 0.867;
/**
 * How far the head mesh is sunk into its own group — and, because the hair
 * hangs at the same offset, the one number that keeps the two meshes aligned.
 *
 * `buildHead` bakes its cells with the origin at the lowest one, so the skull's
 * cell (x,y,z) lands at (x*S, y*S + HEAD_DROP, z*S) and a hair cell, at half the
 * size, lands at exactly half of that. Written once, used twice: a hairstyle
 * would otherwise float a third of a voxel over the scalp the day this moved.
 */
const HEAD_DROP = -0.03;

/**
 * A camera-relative silhouette lift, independent of the world's lighting.
 *
 * Games commonly use a Fresnel/rim response to keep an actor separable in a
 * dark shot. This adds at most 0.028 linear blue at a perfectly grazing angle,
 * falls off to almost nothing over the front planes, and never touches the
 * emissive channel — so selective bloom cannot mistake the hero for a lamp.
 */
const ACTOR_RIM_STRENGTH = 0.055;
function installActorHighlight(material: THREE.MeshStandardMaterial): void {
  material.userData.bsNightRole = "hero-highlight";
  material.userData.bsDebugIntensity = ACTOR_RIM_STRENGTH;
  material.customProgramCacheKey = (): string => "bsActorRim-v1";
  material.onBeforeCompile = (shader): void => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float bsActorRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 4.0);
       outgoingLight += vec3(0.22, 0.32, 0.50) * (bsActorRim * ${ACTOR_RIM_STRENGTH.toFixed(3)});
       #include <opaque_fragment>`,
    );
  };
}

/**
 * THE SKULL IS NOT A BOX. How far each row is stepped back at its corners, as a
 * limit on `|x| + |z|` measured from cell CENTRES — so 6 nips the four corner
 * cells off, 5 takes a two-cell bevel and 4 a three-cell one. Indexed by row,
 * chin (y 0) first.
 *
 * A cube head is the one thing that stops this reading as a low-poly character
 * and starts it reading as a die with a face drawn on it. What a PSX-era artist
 * did instead — with a vertex budget that could not afford a real sphere — is
 * exactly this: keep the flats where the detail is and STEP the corners, more
 * of it the further from the eye line you get.
 *
 * So the rows are not uniform, and each number is a decision:
 *
 *   y 0   6   the jaw. The chin's UNDERSIDE stays full — a chamfer there reads
 *             as a pointed chin on a chibi — and only its side corners are
 *             nipped, which is the "a bit cutoff on the sides" of the reference.
 *   y 1-3 6   the face. It cannot go past 6: the outer eye cells sit at
 *             |x| + |z| = 6 exactly, and a two-cell bevel would delete them.
 *             The blush moved inboard a cell for the same reason.
 *   y 4   5
 *   y 5   4   the crown, roundest, because that is the silhouette a hat-less
 *             style (`buzz`, `mohawk`) leaves showing.
 *
 * The BOUNDS are unchanged by all of this — the ears still reach x ±5 and the
 * box still spans z -4..3 — so `build`'s centring, and with it the hair mount
 * that assumes hair cell 2x sits on skull cell x, does not move.
 */
const SKULL_PLAN = [6, 6, 6, 6, 5, 4];
/**
 * The rows that reach the head's OUTER SHELL — its front, back and side planes.
 * Above and below them the shell steps in by a cell, which is the difference
 * between a chamfered box and a head.
 *
 * The corner rule above only cuts on the diagonal, so the front stayed a flat
 * six-by-six slab with the face painted on it: rounded in plan, dead straight
 * in elevation. This curves the other axis. The face plane now exists for four
 * rows out of six, the chin steps back under it, and the crown steps back over
 * it — one level of sphere on all four vertical faces.
 *
 * 1 AND 4 ARE WHAT THE FACE CAN AFFORD. The eyes sit on rows 2-3 and the blush
 * on row 1, so the front plane cannot start any higher; the mouth was on row 0
 * and moved back a cell with the chin rather than being left floating a cell
 * proud of it. A second level of rounding needs a finer grid than 8x8x6 — see
 * the note on the hair's resolution in player/hair.ts for what that would cost.
 */
const SKULL_SHELL = { from: 1, to: 4 };

/**
 * The head WITHOUT its hair — skull, ears and face.
 *
 * The hair is a model of its own at twice this grid's resolution and it hangs
 * off `HAIR_ORIGIN` below; see the note at the top of player/hair.ts for why,
 * and for the rule that keeps the two meshes off each other's planes.
 */
function buildHead(): THREE.Mesh {
  const v = new VoxelModel();
  // The skull: stepped back at the corners row by row (SKULL_PLAN), and stepped
  // back again at the chin and the crown (SKULL_SHELL).
  for (let y = 0; y < SKULL_PLAN.length; y++) {
    const shell = y >= SKULL_SHELL.from && y <= SKULL_SHELL.to;
    for (let x = -4; x <= 3; x++) {
      for (let z = -4; z <= 3; z++) {
        const ax = Math.abs(x + 0.5);
        const az = Math.abs(z + 0.5);
        if (ax + az > SKULL_PLAN[y]) {
          continue;
        }
        if (!shell && (ax > 2.5 || az > 2.5)) {
          continue;
        }
        v.set(x, y, z, SKIN);
      }
    }
  }
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
  // Little smile, on the chin row — which now sits a cell BACK from the face
  // plane above it (SKULL_SHELL), so the mouth goes to z 2 with it. At 3 it
  // would be a cell of lip floating clear of the head.
  v.set(-1, 0, 2, MOUTH);
  v.set(0, 0, 2, MOUTH);
  // Inboard of the corner the row above cut away: at x -4 / 3 these would be
  // painting cells the skull no longer has, and `set` ADDS one rather than
  // refusing — a blush that put the corner of the head back.
  v.set(-3, 1, 3, BLUSH);
  v.set(2, 1, 3, BLUSH);
  const mesh = v.build(S, true);
  mesh.position.y = HEAD_DROP;
  return mesh;
}

/**
 * The tunic, four rows of it, plus a COLLAR ROW STEPPED IN ONE CELL ALL ROUND.
 *
 * Shoulders on a chibi are not square: the mass narrows where the head sits on
 * it, and a torso that runs full width to its top edge reads as a crate with a
 * head balanced on the lid. One cell in from each of the four sides is the
 * smallest step the grid can make, and it is enough — the corner it cuts is
 * what the eye reads as a shoulder line.
 *
 * IT CHANGES NO COLLIDER. The hero's own collision is a capsule in player/,
 * measured from his height and not from this mesh, so nothing about where he
 * can stand or what he bumps into moves with it.
 */
const COLLAR_ROW = 4;
function buildTorso(): THREE.Mesh {
  const v = new VoxelModel();
  // tunic — five rows, not six: the head took the height back (see HEAD_SCALE)
  v.box(-4, 0, -2, 3, COLLAR_ROW - 1, 1, TUNIC);
  v.box(-3, COLLAR_ROW, -1, 2, COLLAR_ROW, 0, TUNIC);
  // shaded sides for a bit of volume
  v.box(-4, 1, -2, -4, 3, 1, TUNIC_D);
  v.box(3, 1, -2, 3, 3, 1, TUNIC_D);
  // belt + gold buckle
  v.box(-4, 0, -2, 3, 0, 1, BELT);
  v.set(0, 0, 1, GOLD);
  v.set(-1, 0, 1, GOLD);
  // Collar trim: the stepped-in top row, recoloured. Its bounds are the row's
  // own — a trim painted at the tunic's full width would `set` the four corners
  // back and undo the step.
  v.box(-3, COLLAR_ROW, -1, 2, COLLAR_ROW, 0, TRIM);
  // Satchel strap, diagonal across the chest. It stops one row BELOW the collar
  // now: the last cell of the old run was (-1, 4, 1), and z 1 is no longer part
  // of the collar row, so painting it would have hung a cell of strap in the air.
  for (let i = 0; i < COLLAR_ROW; i++) {
    v.set(3 - i, i, 1, BELT_D);
  }
  // backpack straps: gold-tan X crossing the tunic back (flush recolor of the
  // z=-2 back layer, so the silhouette is untouched); stops below the collar
  for (let i = 0; i <= 3; i++) {
    v.set(3 - i, i, -2, STRAP); // right shoulder -> left hip
    v.set(-4 + i, i, -2, STRAP); // left shoulder -> right hip
  }
  return v.build(S, true);
}

/**
 * The lower body: ONE block, not two legs.
 *
 * A hip slab with two stubs merged under it and a notch between them — the
 * shape reads as legs without articulating any, which is the whole point of the
 * silhouette. It is 9 voxels across against the torso's 8 so no side face of
 * either lands on the other's plane where they overlap.
 */
function buildHips(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-4, 1, -2, 4, 2, 2, PANTS); // slab
  v.box(-4, 0, -2, -1, 0, 2, PANTS); // stubs, one voxel of daylight between them
  v.box(1, 0, -2, 4, 0, 2, PANTS);
  // shaded outer faces, the same trick the tunic uses
  v.box(-4, 0, -2, -4, 2, 2, BOOT_D);
  v.box(4, 0, -2, 4, 2, 2, BOOT_D);
  const mesh = v.build(S, true);
  mesh.position.y = HIPS_DROP;
  return mesh;
}

/**
 * A free-floating boot: sole and toe low, ankle stepped up over the back half,
 * and the toe tip narrowed so the nose rounds off in plan view. Nothing joins
 * it to the body — it hangs under the hip pivot and the animator swings it.
 */
function buildBoot(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-2, 0, -1, 1, 0, 2, BOOT); // sole and instep, toes at +z
  v.box(-1, 0, 3, 0, 0, 3, BOOT); // toe cap, two voxels narrower
  v.box(-2, 1, -1, 1, 1, 1, BOOT_D); // ankle step over the heel half
  const mesh = v.build(S, true);
  mesh.position.y = BOOT_DROP;
  return mesh;
}

/**
 * A free-floating mitt: the stepped ball the Blender model builds cell by cell.
 *
 * FIVE CELLS ACROSS, AND THE SHAPE IS THE POINT. It has been three things: a
 * radius so small (1.9) that all 27 cells of a 3x3x3 passed and the "ball"
 * baked out as a perfect cube; then a distance field at r^2 = 8, 93 of 125,
 * which kept the twelve edge cells and rounded into a blob; and now the
 * `stepped_ball` mask the Blender source uses — 81 of 125, a cube with one step
 * raised on each face. That reads as a low-resolution sphere rather than as a
 * smooth one, which is the whole register this game draws in.
 *
 * IT IS THE SAME MASK AS models/chibi_base.py, deliberately, and the two cannot
 * share code across TypeScript and Python — so they share a NUMBER instead:
 * 81 of 125. If one of them ever says something else, they have drifted.
 *
 * The mesh is then scaled DOWN, because five cells at the body's own 0.1 would
 * be a 0.5 hand on a 1.7 body.
 *
 * MITT_SCALE and the grip are one number apart on purpose — see GRIP_LOCAL_Y.
 *
 * It hangs below its shoulder pivot on purpose: the animator swings the arm
 * with `rotation.x`, and a mitt centred ON the pivot would spin in place.
 */
/** Half the mitt's span in cells: it runs -2..2, five across, as it always has. */
const MITT_CELL_R = 2;
function buildMitt(): THREE.Mesh {
  const v = new VoxelModel();
  // A CUBE WITH ONE STEP RAISED ON EACH FACE: the 3x3x3 core plus a 3x3 plate
  // per side, 81 of the 125 cells. A cell is in if AT MOST ONE of its axes is
  // out at the rim — two means an edge, three a corner, and those twenty are
  // exactly what this drops.
  for (let x = -MITT_CELL_R; x <= MITT_CELL_R; x++) {
    for (let y = -MITT_CELL_R; y <= MITT_CELL_R; y++) {
      for (let z = -MITT_CELL_R; z <= MITT_CELL_R; z++) {
        const rim =
          +(Math.abs(x) === MITT_CELL_R) +
          +(Math.abs(y) === MITT_CELL_R) +
          +(Math.abs(z) === MITT_CELL_R);
        if (rim <= 1) {
          v.set(x, y, z, SKIN);
        }
      }
    }
  }
  // Cuff: a recolour of the top plate, where a sleeve would have ended. It is
  // painted CELL BY CELL over exactly the plate's own 3x3, not with a radius —
  // `ellipsoid` SETS cells rather than tinting the ones already there, so the
  // old radius-2 disc would paint the four edge cells at y = 2 back in and undo
  // the step this shape is made of.
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      v.set(x, 2, z, SKIN_EAR);
    }
  }
  const mesh = v.build(S, true);
  mesh.scale.setScalar(MITT_SCALE);
  mesh.position.y = MITT_DROP;
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
  v.set(0, 4, 0, GOLD); // throat band at the belt
  v.set(0, 0, 0, STEEL_D); // chape tip
  const mesh = v.build(S, true);
  mesh.position.y = -0.48;
  return mesh;
}

export function buildHeroRig(): HeroRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  hips.add(buildHips());
  body.add(hips);

  // Boots hang from the HIP, not from an ankle: the lever is what turns the
  // animator's existing leg swing into a stride for a foot with no leg on it.
  const legR = new THREE.Group();
  legR.position.set(-BOOT_X, HIP_Y, 0);
  legR.add(buildBoot());
  const legL = new THREE.Group();
  legL.position.set(BOOT_X, HIP_Y, 0);
  legL.add(buildBoot());
  body.add(legL, legR);

  const torso = new THREE.Group();
  torso.position.y = TORSO_Y;
  torso.add(buildTorso());
  body.add(torso);

  const head = new THREE.Group();
  head.position.y = NECK_LOCAL_Y;
  head.scale.setScalar(HEAD_SCALE);
  head.add(buildHead());
  torso.add(head);

  // The hair hangs in a mount rather than being a child of the skull, so
  // `setHairStyle` swaps ONE object and nothing else in the head is rebuilt.
  const hair = new THREE.Group();
  hair.position.y = HEAD_DROP;
  head.add(hair);

  // -x is his right. See the note at the top of the file.
  const armR = new THREE.Group();
  armR.position.set(-SHOULDER_X, SHOULDER_LOCAL_Y, 0);
  armR.add(buildMitt());
  const armL = new THREE.Group();
  armL.position.set(SHOULDER_X, SHOULDER_LOCAL_Y, 0);
  armL.add(buildMitt());
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
  sword.position.set(0, GRIP_LOCAL_Y, 0);
  sword.rotation.x = 2.05;
  sword.rotation.y = 0.85;
  armR.add(sword);

  /**
   * The back holster: where the weapon rides between fights.
   *
   * On the TORSO, so it turns with the shoulders and not with the hips. The
   * pose is the one every sword-carrying RPG uses and it is not decoration:
   * laid across the back at 45 degrees with the hilt at the right shoulder,
   * the grip is inside the arc the right hand already sweeps, so drawing it is
   * a reach and not a contortion. `HOLSTER_TILT` presses the flat of the blade
   * against the back instead of standing it off the tunic like a wing.
   */
  const holster = new THREE.Group();
  holster.position.set(HOLSTER_POS.x, HOLSTER_POS.y, HOLSTER_POS.z);
  torso.add(holster);

  // Satchel and scabbard moved onto the BACK. They used to ride the left flank
  // at chest height, which is now open air the mitt swings through: with no arm
  // between hand and body, anything out there reads as a box floating beside
  // him. The satchel ended up back on a FLANK rather than the back:
  // the back belongs to the stowed weapon, whose diagonal sweeps all of it, and
  // every corner it left free was one a long weapon's tip reached anyway. It
  // sits on his LEFT, opposite the weapon hand, far enough FORWARD (z 0.11) to
  // be clear of the stowed blade's plane at -0.27, and inboard of 0.445, where
  // the mitt's inner face passes — so the hand swings past it and not through
  // it, and neither does a greatsword's tip.
  const satchel = buildSatchel();
  satchel.position.set(0.34, 0.42, 0.11);
  satchel.rotation.y = Math.PI / 2;
  satchel.rotation.z = 0.08;
  body.add(satchel);

  // scabbard behind the left hip, angled tip-back so it reads from behind.
  // Inboard of x -0.43, which is where the mitt's inner face passes.
  const scabbard = new THREE.Group();
  scabbard.position.set(-0.3, 0.52, -0.3);
  scabbard.rotation.x = 0.3;
  scabbard.rotation.z = -0.15;
  scabbard.add(buildScabbard());
  body.add(scabbard);

  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
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
      installActorHighlight(mesh.material);
      materials.push(mesh.material);
    }
  });

  const rig: HeroRig = {
    root,
    body,
    torso,
    head,
    hair,
    armL,
    armR,
    legL,
    legR,
    hips,
    sword,
    holster,
    scabbard,
    materials,
    weapon: null,
    stowed: false,
    hairStyle: "",
    hairColour: 0,
  };
  setWeaponModel(rig, "sword");
  // What the player last chose, or the first style in its own colour. Read here
  // rather than passed in: every caller that builds a hero (the game, the lab,
  // test-zfight) wants the same answer, and the one that wants a different one
  // says so by calling `setHairStyle` after.
  setHairStyle(rig, storedHairStyle(), storedHairColour());
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
/**
 * Lay whatever is in the mount along the back, centred on the holster.
 *
 * THE ANGLE IS DERIVED, not written down five times. 45 degrees is the carry
 * everyone means, and it is what a sword gets — but the band between the boots
 * and the head's overhang is 0.62 tall, and a greatsword hung at 45 has a
 * vertical reach of 0.71. So the rule is: 45 unless the weapon is too long for
 * the band, then as much flatter as it takes. A scythe ends up nearly across
 * the shoulders, which is how a polearm is carried anyway.
 *
 * Centred, too: the mount is the GRIP, so hanging it straight off the anchor
 * puts short weapons high and long ones through the ground. The model's own
 * extent along the blade decides the offset, so nothing here knows what a
 * greatsword is.
 */
function layOnBack(mount: THREE.Group): void {
  const held = mount.children[0] as THREE.Mesh | undefined;
  mount.position.set(0, 0, 0);
  mount.rotation.set(0, 0, HOLSTER_ANGLE);
  if (!held) {
    return;
  }
  held.geometry.computeBoundingBox();
  const bb = held.geometry.boundingBox!;
  // the model's reach along its own blade axis, in the mount's space
  const lo = bb.min.y * held.scale.y + held.position.y;
  const hi = bb.max.y * held.scale.y + held.position.y;
  const length = hi - lo;
  const centre = (hi + lo) / 2;
  // Flatten only as far as the band demands, and keep the carry on the side
  // HOLSTER_ANGLE asks for: `acos` has no sign, so taking it without this puts
  // every weapon back over the same shoulder whatever the constant says.
  const cos = Math.min(Math.abs(Math.cos(HOLSTER_ANGLE)), length > 0 ? HOLSTER_BAND / length : 1);
  const angle = Math.sign(HOLSTER_ANGLE) * (Math.PI - Math.acos(Math.min(1, cos)));
  mount.rotation.set(0, 0, angle);
  // slide back along the blade so the weapon straddles the anchor
  mount.position.set(Math.sin(angle) * centre, -Math.cos(angle) * centre, 0);
}

/** Put the mount back in the hand that holds this weapon. */
function handWeapon(rig: HeroRig, id: WeaponModelId | null): void {
  const mount = id === "bow" ? rig.armL : rig.armR;
  if (rig.sword.parent === mount) {
    return;
  }
  mount.add(rig.sword);
  rig.sword.position.set(0, GRIP_LOCAL_Y, 0);
  // Yawed off-axis so the flat of the blade never faces the camera square-on,
  // mirrored by the side the hand is on rather than by its name.
  rig.sword.rotation.set(2.05, Math.sign(mount.position.x) * 0.85, 0);
}

/**
 * Put the weapon on the back, or take it off the back.
 *
 * The MOUNT moves, the model does not: `sword` is the hand, so everything
 * hanging off it — the model, its `FIT`, the damage-flash material — travels
 * with one reparent and nothing downstream has to know where it went. While it
 * is stowed the animator leaves `sword.rotation` alone (see `AnimInput.stowed`),
 * because the holster's own angle IS the pose.
 *
 * A bow goes on the back the same way. It rides the same diagonal: an archer's
 * bow over the shoulder and a swordsman's blade land in the same place, and one
 * carry is one thing to look at rather than two.
 */
export function stowWeapon(rig: HeroRig, stowed: boolean): void {
  if (rig.stowed === stowed) {
    return;
  }
  rig.stowed = stowed;
  // The hip scabbard is the sheath for a DRAWN weapon — an empty one on the
  // belt is right while he is holding the sword, and one more strap crossing
  // the blade's diagonal when he is not.
  rig.scabbard.visible = !stowed;
  if (stowed) {
    rig.holster.add(rig.sword);
    layOnBack(rig.sword);
  } else {
    handWeapon(rig, rig.weapon);
  }
}

export function setWeaponModel(rig: HeroRig, id: WeaponModelId | null): void {
  if (rig.weapon === id) {
    return;
  }
  rig.weapon = id;
  // A BOW IS HELD IN THE LEFT HAND — issue #118. The bow arm holds the weapon
  // straight out and the RIGHT hand draws the string, which is the shape an
  // archer has; four blades and a fist all come out of the right shoulder.
  //
  // The mount MOVES rather than being duplicated. `sword` is the hand (see the
  // note where it is built), and everything downstream — `FIT`, the animator's
  // one `rig.sword.rotation` write, the material pruning above — is written
  // against exactly one of them. A second group on `armL` would fork all three;
  // reparenting one group forks nothing.
  //
  // Mirrored, not copied: the offsets that push the grip outboard of the right
  // calf push it into the left one unless x and the yaw change sign.
  // Stowed weapons stay stowed across a swap: what changes here is WHICH model
  // hangs in the mount, never where the mount is.
  if (!rig.stowed) {
    handWeapon(rig, id);
  }
  const held = rig.sword.children[0] as THREE.Mesh | undefined;
  if (held) {
    rig.sword.remove(held);
    const mat = held.material as THREE.MeshStandardMaterial;
    const at = rig.materials.indexOf(mat);
    if (at >= 0) {
      rig.materials.splice(at, 1);
    }
    disposeWeapon(held);
  }
  if (!id) {
    return;
  }
  const mesh = buildWeaponModel(id);
  installActorHighlight(mesh.material as THREE.MeshStandardMaterial);
  rig.sword.add(mesh);
  rig.materials.push(mesh.material as THREE.MeshStandardMaterial);
}

/**
 * Put a hairstyle on the hero, in a colour.
 *
 * `colour` is the PICKED one, so `null` means nothing has been picked and the
 * style is drawn in the colour it was designed in (see the storage note in
 * player/hair.ts). The resolved answer is left on the rig, which is what the
 * debug panel shows in its swatch — nothing else has to repeat the rule.
 *
 * Rebuilding is the only way to recolour: `VoxelModel` bakes colour into vertex
 * attributes, so there is no material to tint. It is one small model, built when
 * somebody changes a row in a panel, and it prunes the outgoing material out of
 * the damage-flash list on the way — the same three steps, in the same order, as
 * `setWeaponModel` above.
 */
export function setHairStyle(rig: HeroRig, styleId: string, colour: number | null): void {
  const style = hairStyle(styleId);
  const hex = colour ?? style.suggested;
  if (rig.hairStyle === style.id && rig.hairColour === hex) {
    return;
  }
  rig.hairStyle = style.id;
  rig.hairColour = hex;
  const old = rig.hair.children[0] as THREE.Mesh | undefined;
  if (old) {
    rig.hair.remove(old);
    const mat = old.material as THREE.MeshStandardMaterial;
    const at = rig.materials.indexOf(mat);
    if (at >= 0) {
      rig.materials.splice(at, 1);
    }
    old.geometry.dispose();
    mat.dispose();
  }
  const mesh = buildHair(style.id, hex);
  mesh.receiveShadow = false; // the hero casts but never receives — see buildHeroRig
  installActorHighlight(mesh.material as THREE.MeshStandardMaterial);
  rig.hair.add(mesh);
  rig.materials.push(mesh.material as THREE.MeshStandardMaterial);
}
