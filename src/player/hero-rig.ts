import * as THREE from 'three';
import { VoxelModel } from '../core/voxel';
import { buildWeaponModel, disposeWeapon, type WeaponModelId } from './weapons';

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
const HIP_Y = 0.44;      // hip pivot, high in the block like the Blender rig
const HIPS_DROP = -0.20; // block base, relative to that pivot
const BOOT_DROP = -0.44; // boot sole, relative to the same pivot
const BOOT_X = 0.21;
const TORSO_Y = 0.50;
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
const MITT_DROP = -0.46;       // hand hangs below the shoulder, so rotation.x swings it
const NECK_LOCAL_Y = 0.46;
/** Ball size, derived: five cells of 0.1, scaled. */
const MITT_SCALE = 0.86;            // -> a 0.43 hand on a 1.71 body
const MITT_D = 5 * S * MITT_SCALE;  // 0.43 across
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
 * A camera-relative silhouette lift, independent of the world's lighting.
 *
 * Games commonly use a Fresnel/rim response to keep an actor separable in a
 * dark shot. This adds at most 0.028 linear blue at a perfectly grazing angle,
 * falls off to almost nothing over the front planes, and never touches the
 * emissive channel — so selective bloom cannot mistake the hero for a lamp.
 */
const ACTOR_RIM_STRENGTH = 0.055;
function installActorHighlight(material: THREE.MeshStandardMaterial): void {
  material.userData.bsNightRole = 'hero-highlight';
  material.userData.bsDebugIntensity = ACTOR_RIM_STRENGTH;
  material.customProgramCacheKey = (): string => 'bsActorRim-v1';
  material.onBeforeCompile = (shader): void => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float bsActorRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 4.0);
       outgoingLight += vec3(0.22, 0.32, 0.50) * (bsActorRim * ${ACTOR_RIM_STRENGTH.toFixed(3)});
       #include <opaque_fragment>`,
    );
  };
}

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
  // tunic — five rows, not six: the head took the height back (see HEAD_SCALE)
  v.box(-4, 0, -2, 3, 4, 1, TUNIC);
  // shaded sides for a bit of volume
  v.box(-4, 1, -2, -4, 3, 1, TUNIC_D);
  v.box(3, 1, -2, 3, 3, 1, TUNIC_D);
  // belt + gold buckle
  v.box(-4, 0, -2, 3, 0, 1, BELT);
  v.set(0, 0, 1, GOLD);
  v.set(-1, 0, 1, GOLD);
  // collar trim
  v.box(-4, 4, -2, 3, 4, 1, TRIM);
  // satchel strap: diagonal across the chest
  for (let i = 0; i <= 4; i++) v.set(3 - i, i, 1, BELT_D);
  // backpack straps: gold-tan X crossing the tunic back (flush recolor of the
  // z=-2 back layer, so the silhouette is untouched); stops below the collar
  for (let i = 0; i <= 3; i++) {
    v.set(3 - i, i, -2, STRAP);  // right shoulder -> left hip
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
  v.box(-4, 1, -2, 4, 2, 2, PANTS);   // slab
  v.box(-4, 0, -2, -1, 0, 2, PANTS);  // stubs, one voxel of daylight between them
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
  v.box(-2, 0, -1, 1, 0, 2, BOOT);    // sole and instep, toes at +z
  v.box(-1, 0, 3, 0, 0, 3, BOOT);     // toe cap, two voxels narrower
  v.box(-2, 1, -1, 1, 1, 1, BOOT_D);  // ankle step over the heel half
  const mesh = v.build(S, true);
  mesh.position.y = BOOT_DROP;
  return mesh;
}

/**
 * A free-floating mitt: the stepped ball the Blender model builds cell by cell.
 *
 * THE RADIUS HAS TO BE BIG ENOUGH TO ROUND ANYTHING. `ellipsoid` keeps every
 * cell whose centre is inside the radius, so at 1.9 all 27 cells of a 3x3x3
 * pass and the "ball" bakes out as a PERFECT CUBE — which is what shipped, and
 * what a cube hand in the game was. A ball needs a five-cell span before there
 * is a corner to cut: 2.83 is r^2 = 8, the same 93-of-125 shape as the voxel
 * sphere in models/chibi_base.py. The mesh is then scaled DOWN, because five
 * cells at the body's own 0.1 would be a 0.5 hand on a 1.7 body.
 *
 * MITT_SCALE and the grip are one number apart on purpose — see GRIP_LOCAL_Y.
 *
 * It hangs below its shoulder pivot on purpose: the animator swings the arm
 * with `rotation.x`, and a mitt centred ON the pivot would spin in place.
 */
const MITT_CELL_R = 2.83;
function buildMitt(): THREE.Mesh {
  const v = new VoxelModel();
  v.ellipsoid(0, 0, 0, MITT_CELL_R, MITT_CELL_R, MITT_CELL_R, SKIN);
  // Cuff: a recolour of the ball's top layer, where a sleeve would have ended.
  // Radius 2 in x/z paints exactly the cells that layer already has — a wider
  // one would ADD the corner cells the ball just cut.
  v.ellipsoid(0, 2, 0, 2.0, 0.5, 2.0, SKIN_EAR);
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
  scabbard.position.set(-0.30, 0.52, -0.30);
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
      installActorHighlight(mesh.material);
      materials.push(mesh.material);
    }
  });

  const rig: HeroRig = {
    root, body, torso, head, armL, armR, legL, legR, hips, sword, holster,
    scabbard, materials, weapon: null, stowed: false,
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
  if (!held) return;
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
  const mount = id === 'bow' ? rig.armL : rig.armR;
  if (rig.sword.parent === mount) return;
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
  if (rig.stowed === stowed) return;
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
  if (rig.weapon === id) return;
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
  if (!rig.stowed) handWeapon(rig, id);
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
  installActorHighlight(mesh.material as THREE.MeshStandardMaterial);
  rig.sword.add(mesh);
  rig.materials.push(mesh.material as THREE.MeshStandardMaterial);
}
