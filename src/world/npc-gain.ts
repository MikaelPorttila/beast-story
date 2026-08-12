/**
 * GAIN — the Encampment's quest giver, and the first NPC in the game.
 *
 * An old scholar in heavy indigo robes with a lighter mantle over his
 * shoulders, bald on top, long white hair at the sides, a beard down to his
 * chest — and the arms of someone who has been curling the same iron since the
 * Horadrim were a going concern. He stands in the middle of camp and does slow,
 * strained reps with a dumbbell in his LEFT hand.
 *
 * This file is the per-character half of the NPC split (see world/npc.ts): a
 * body built out of `VoxelModel` like every other model in the game and one
 * `animate(rig, ctx)`. It holds no placement, no collision policy, no state
 * machine — and since issue #60 no identity and no dialogue either: who he is,
 * where he stands and what he says are content, and only the CHOICE of this
 * body is (`"body": "gain"`). See `GAIN_BODY` at the bottom.
 *
 * THE BODY IS FOUR MODELS, and which cells go in which one is a decision the
 * collider depends on:
 *
 *   body      robe, belt, torso, mantle, deltoids, neck — everything that does
 *             not move. This is the model his FOOTPRINT is measured off
 *             (world/structures.ts), so his collider is his standing mass and
 *             nothing else: not the head that nods, and not the weight that
 *             swings through where a body would have been.
 *   head      skull, hair, beard. Nods and scans.
 *   arm       one upper arm and one forearm+fist, built once and used for both
 *             sides — he is symmetrical, only his pose is not.
 *   dumbbell  bar and plates, riding in the left fist.
 *
 * VOXEL SCALE is the hero's 0.1 (1 cell = 10 cm) rather than the town's coarse
 * 0.28, because he is a character standing next to the hero and has to hold up
 * at conversation distance: a face, a beard and a bicep do not survive being
 * quantised to 28 cm. At 0.1 he measures ~2.0 units to the top of the skull,
 * against the hero's 1.9 — a big old man, not a giant.
 */
import * as THREE from "three";
import { VoxelModel } from "../core/voxel";
import { relight } from "./props";
import { measureFootprint } from "./structures";
import type { NpcAnimCtx, NpcBody, NpcRig } from "./npc";

/** World units per voxel. See the header. */
const S = 0.1;

// -- palette ---------------------------------------------------------------
// sRGB hex like every other builder in the project; VoxelModel converts.
const ROBE = 0x39406e; // deep indigo, the Diablo II silhouette
const ROBE_D = 0x2a3054; // folds and the shaded side
const MANTLE = 0x6c78a8; // the lighter over-shoulder cape
const MANTLE_D = 0x545f88;
const SKIN = 0xd8a274; // weathered
const SKIN_D = 0xb8814f; // creases, undersides, the fist
const SKIN_L = 0xe6b98f; // the bald pate, catching the sun
const HAIR = 0xeceadf; // white, but warm — a pure white blows out under bloom
const HAIR_D = 0xcdc9ba;
const LEATHER = 0x6b4a2e;
const BUCKLE = 0xc9a24f;
const EYE = 0x2a2530;
// Iron, and lighter than the town's 0x4b4b53. Captured at that value
// (_gain-b.png, first pass) the whole dumbbell went to a dark blob against the
// indigo robe with the plates and the sleeve indistinguishable; at 0x6e7079 the
// bar is still obviously metal and still obviously heavy, and it reads against
// both the robe and the camp's ground.
const IRON = 0x6e7079; // the dumbbell's plates
const IRON_L = 0x9a9ca6;
const GRIP = 0x3a3128; // knurled leather on the bar

// -- proportions (world units) ---------------------------------------------
// Every one of these is read by both the rig builder and the animator, so the
// pose and the parts can never disagree about where a joint is.
const SHOULDER_Y = 1.15;
const SHOULDER_X = 0.52;
/**
 * How far forward the head hangs off the neck — and the reason it is 0.02 and
 * not 0 is a DEPTH BUFFER one, not an anatomical one.
 *
 * `VoxelModel.build` lays every face of a model on a multiple of S, re-based on
 * that model's own bounds. Two parts therefore share a face grid in an axis
 * exactly when the joint between them is a whole multiple of S in that axis —
 * and where two shared-grid parts also overlap in space, their faces are
 * COINCIDENT and the depth buffer has to pick one at random. It picks
 * differently either side of a quad's diagonal, so what ships is a hard
 * diagonal seam swimming across the model as the camera moves.
 *
 * That is what the back of this man's head was: his hair (z = -0.4) and the
 * hood collar behind it (z = -0.4) were the same plane, cream against indigo,
 * and the seam cut across the back of his skull. `NECK_Y = 1.32` had already
 * parted the two grids in Y by 2 cm without anyone writing down that it was
 * doing so; this is the same 2 cm in Z, stated on purpose. It is a fifth of a
 * voxel, invisible on a 2 m man, and it takes every z-plane he has off the
 * body's grid at once — the hood at the back and the beard against the lapels
 * at the front.
 *
 * X is NOT parted, because the head has to stay centred on the body and an
 * offset there is an asymmetry you can see. His X collisions are fixed in the
 * paint instead — the cape is a voxel wider than the head and the torso's
 * shoulder corners are filled out past it, both below.
 * `bun tools/test-zfight.mjs` is what says whether that is still true.
 */
const NECK_Z = 0.02;
/** Shoulder to elbow. Deliberately short — see ARM REACH below. */
const UPPER_ARM = 0.45;
/** Elbow to the middle of the fist. */
const FOREARM = 0.42;
const NECK_Y = 1.32;

/**
 * ARM REACH. The two lengths above are short for a man of his height, and that
 * is what keeps the weight out of the floor at one end of the rep and out of
 * his own chest at the other. Both ends are arithmetic off the numbers above
 * rather than taste:
 *
 *   - at rest the elbow hangs at 1.15 - 0.45 = 0.70 and, at the EXT angle
 *     below, the fist at ~0.33. The plates are 0.25 in radius, so the bottom of
 *     the weight clears the ground by ~0.08. A full-length arm (0.55 / 0.50)
 *     puts it through the floor, which is why these are not the hero's.
 *   - at peak flex the fist arrives ~1.06 up and ~0.33 forward of the shoulder,
 *     which is level with the collarbone and clear of the chest in z.
 */

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * Everything that does not move — and therefore, exactly, the thing that blocks.
 *
 * The x bounds come out at -6..5 and the z bounds at -4..3, i.e. min + max =
 * -1 on both axes. That is not cosmetic: `VoxelModel.build`'s centred mode and
 * `measureFootprint` both re-base on `(min + max + 1) / 2`, so a model obeying
 * that rule has its mesh and its collider on the same origin with no fixup, and
 * a model that breaks it puts the box half a voxel off the body.
 */
function buildBody(): VoxelModel {
  const v = new VoxelModel();

  // -- robe ----------------------------------------------------------------
  // The hem is the widest thing at ground level so he reads as planted rather
  // than as a figure standing on a point.
  v.box(-5, 0, -3, 4, 1, 2, ROBE_D);
  v.box(-4, 2, -3, 3, 4, 2, ROBE);
  // Vertical folds: alternating darker columns down the outside faces, so the
  // skirt is cloth rather than a painted block.
  for (const x of [-4, -1, 2]) {
    v.box(x, 0, 2, x, 4, 2, ROBE_D);
  }
  for (const x of [-3, 0, 3]) {
    v.box(x, 0, -3, x, 4, -3, ROBE_D);
  }
  v.box(-5, 0, -3, -5, 1, 2, ROBE_D);
  v.box(4, 0, -3, 4, 1, 2, ROBE_D);
  // Sandals under the hem, mirrored about the -1 rule (-3..-1 and 0..2).
  v.box(-3, 0, 3, -1, 0, 3, LEATHER);
  v.box(0, 0, 3, 2, 0, 3, LEATHER);

  // -- belt ----------------------------------------------------------------
  v.box(-4, 5, -3, 3, 5, 2, LEATHER);
  v.set(-1, 5, 2, BUCKLE);
  v.set(0, 5, 2, BUCKLE);

  // -- torso ---------------------------------------------------------------
  v.box(-4, 6, -3, 3, 12, 2, ROBE);
  v.box(-4, 6, -3, -4, 12, 2, ROBE_D); // shaded flanks
  v.box(3, 6, -3, 3, 12, 2, ROBE_D);

  // A CHEST THAT DOES NOT FIT THE ROBE — but a NARROW one, four voxels across
  // between two lapels. Captured at six wide (_gain-front-down.png, first pass)
  // the opening was the same tan as his face and ran from the belt to the
  // collar, so the whole front of him read as one skin-coloured slab with a
  // beard lost somewhere in the middle of it.
  v.box(-2, 8, 2, 1, 12, 2, SKIN_D);
  v.box(-2, 10, 2, 1, 12, 2, SKIN);
  // The pectorals, one voxel proud — and deliberately stopping at y 9, which is
  // where the beard hanging over them starts. Two meshes may overlap, but
  // whichever is in front has to be strictly in front: a face of his chest
  // exactly coplanar with a face of his beard is z-fighting.
  v.box(-2, 8, 3, 1, 9, 3, SKIN);
  v.box(-1, 8, 3, 0, 9, 3, SKIN_D); // sternum split
  v.box(-2, 8, 3, 1, 8, 3, SKIN_D); // under-pec crease
  // The robe's lapels, framing the opening so it reads as an open robe rather
  // than as a hole cut in one.
  v.box(-4, 7, 2, -3, 13, 3, ROBE_D);
  v.box(2, 7, 2, 3, 13, 3, ROBE_D);
  v.box(-4, 13, 2, 3, 13, 2, ROBE);

  // -- deltoids ------------------------------------------------------------
  // Mirrored about the -1 rule: centres 4 and -5 put the spans at x 3..5 and
  // -6..-4, so the body measures 12 voxels across the shoulders against the
  // hero's 8 across the chest.
  v.ellipsoid(4, 11.5, -0.5, 1.9, 2.2, 2.4, ROBE);
  v.ellipsoid(-5, 11.5, -0.5, 1.9, 2.2, 2.4, ROBE);
  v.ellipsoid(4, 12.4, -0.5, 1.5, 1.2, 1.8, MANTLE_D); // the mantle over them
  v.ellipsoid(-5, 12.4, -0.5, 1.5, 1.2, 1.8, MANTLE_D);
  // THE SHOULDER CORNERS, which the deltoids round off and therefore leave
  // open: an ellipsoid 2.4 deep on a torso 6 deep does not reach the front and
  // back columns, so the torso's own flanks stood bare on x = +-0.4 for the
  // three rows either side of the collarbone. That is head height — his hair
  // hangs down to y -3 — and the head is exactly as wide as the torso, so every
  // one of those columns met a white hair panel on a shared plane. Filled here,
  // the corners are mantle out to x = +-0.5 and the head meets nothing.
  for (const x of [-5, 4]) {
    v.box(x, 10, -4, x, 12, -3, MANTLE_D);
    v.box(x, 10, 2, x, 12, 2, MANTLE_D);
  }

  // -- mantle --------------------------------------------------------------
  // WIDER THAN THE HEAD, by one voxel a side, and that is load-bearing as well
  // as right: at x -4..3 the cape's outer faces stood on x = +-0.4, which is
  // exactly where the head's hair panels stand, and the two fought all the way
  // down the side of his skull. A cape thrown over a pair of shoulders should
  // overhang the head anyway. Mirrored about the -1 rule, so the origin is
  // untouched (see `buildBody`'s header).
  v.box(-5, 13, -4, 4, 14, 2, MANTLE);
  v.box(-4, 8, -4, 3, 12, -4, MANTLE_D); // drapes down the back
  for (const x of [-3, 0, 3]) {
    v.box(x, 8, -4, x, 12, -4, MANTLE);
  } // fold highlights
  // Standing collar behind the neck — ONE voxel deep, at z = -4 and no longer
  // also at -3, and narrowed to x -2..1 from -3..2. Both of those are the same
  // fix. The head's own hair used to be painted at z = -4 as well, so the
  // collar and the back of his head were not merely on shared planes, they were
  // in the SAME CELLS: two solids occupying one layer, sweeping through each
  // other every time he turned to look at somebody, and the boundary where they
  // crossed read as a hard diagonal cutting across the back of his skull. The
  // hair has moved forward a layer (see `buildHead`); this stays put and is now
  // the 2 cm of collar standing proud behind it, which is what it was always
  // meant to be.
  v.box(-2, 15, -4, 1, 17, -4, MANTLE);
  v.box(-2, 15, -4, 1, 15, -4, MANTLE_D);

  // -- satchel, on his right hip ------------------------------------------
  // The one prop off the reference that survived: he carries the Horadric
  // paperwork whether or not anyone asks for it.
  v.box(-6, 4, -1, -5, 7, 1, LEATHER);
  v.box(-6, 8, -1, -5, 8, 1, 0x54371f);
  v.set(-6, 6, 1, BUCKLE);
  for (let i = 0; i <= 5; i++) {
    v.set(-5 + i, 8 + i, 2, LEATHER);
  } // strap across the chest

  // -- neck ----------------------------------------------------------------
  v.box(-2, 13, -2, 1, 14, 1, SKIN_D);

  return v;
}

/**
 * Skull, hair, beard — the half of the silhouette that says which old man this
 * is. Painted around a voxel origin at the NECK, so the model's own y runs
 * negative through the beard; the rig applies the offset (see `mkMesh`).
 */
function buildHead(): VoxelModel {
  const v = new VoxelModel();

  // Skull. 6 wide against the hero's 8, and unlike the hero it is NOT scaled
  // down afterwards: a big head on a bulked-up body reads as a toy, and the
  // beard already does the work a large head would have done.
  v.box(-3, 0, -3, 2, 5, 2, SKIN);
  v.box(-3, 5, -3, 2, 5, 2, SKIN_L); // the bald pate, a value up
  v.box(-2, 6, -2, 1, 6, 1, SKIN_L);

  // THE FACE IS A BROW AND TWO EYES UNDER IT, and the relief is doing all of
  // the work: the ridge stands one voxel PROUD at z = 3 and the eyes sit on the
  // face plane at z = 2, so what reads at conversation distance is the shadow
  // the ridge casts rather than the two dark cells themselves. The first pass
  // put ridge and eyes on the same proud layer, and captured
  // (_gain-front-down.png) they merged into one dark band across his face — a
  // visor, not an expression.
  v.box(-2, 4, 3, 1, 4, 3, SKIN);
  v.set(-3, 4, 2, SKIN_D);
  v.set(2, 4, 2, SKIN_D);
  v.set(-2, 3, 2, EYE);
  v.set(1, 3, 2, EYE);
  v.box(-1, 2, 3, 0, 3, 3, SKIN); // nose, proud like the brow
  v.box(-1, 1, 3, 0, 1, 3, SKIN_D); // and its shadow

  // White hair: a ring round the back and sides of a bald crown, falling past
  // the jaw. Painted AFTER the skull so it overwrites the temples.
  v.box(-4, -1, -3, -4, 5, 1, HAIR);
  v.box(3, -1, -3, 3, 5, 1, HAIR);
  v.box(-4, -3, -3, -4, -2, -1, HAIR_D); // side locks, past the beard line
  v.box(3, -3, -3, 3, -2, -1, HAIR_D);
  // The back of the head, and the length down his neck — painted at z = -3, ON
  // the skull's own rear layer, exactly as the panels above overwrite the
  // temples. It used to be a layer ADDED behind the skull at z = -4, which is
  // the same cell the mantle and the hood collar occupy: two solids in one
  // layer, crossing each other as he nods and scans, and a hard diagonal where
  // they crossed. Forward a layer, the whole head clears the cape with 2 cm to
  // spare and the silhouette is a centimetre shallower.
  v.box(-3, -2, -3, 2, 5, -3, HAIR);
  v.box(-3, -2, -3, 2, -1, -3, HAIR_D);
  for (const x of [-4, 3]) {
    for (const y of [0, 2, 4]) v.set(x, y, 1, HAIR_D);
  }

  // Beard: full width at the jaw, tapering to a point that stops just above
  // the top of the pectorals — see the note on coplanar faces in `buildBody`.
  v.box(-3, -1, 1, 2, 0, 3, HAIR);
  v.box(-2, -3, 1, 1, -2, 3, HAIR);
  v.box(-2, -3, 1, 1, -3, 3, HAIR_D); // the shaded tip
  v.box(-3, -1, 1, 2, -1, 1, HAIR_D); // the underside, in its own shadow
  v.box(-2, 1, 3, 1, 1, 3, HAIR); // moustache, under the nose

  return v;
}

/** Upper arm: a sleeve cap over a bicep that is the point of the character. */
function buildUpperArm(): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -0.4, 0, 2.0, 1.5, 2.0, ROBE); // sleeve, torn off at the shoulder
  v.ellipsoid(-0.5, -2.6, 0, 2.2, 2.4, 2.0, SKIN); // bicep belly
  v.ellipsoid(-0.5, -2.4, 1.2, 1.7, 2.0, 1.4, SKIN); // ...bulging forward
  v.ellipsoid(-0.5, -2.8, -1.4, 1.5, 1.9, 1.2, SKIN_D); // triceps, in shade
  v.ellipsoid(-0.5, -4.6, 0, 1.5, 1.2, 1.5, SKIN_D); // elbow
  return v;
}

/** Forearm and fist, painted from the elbow down. */
function buildForearm(): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -1.4, 0, 2.0, 1.9, 1.9, SKIN);
  v.ellipsoid(-0.5, -3.0, 0, 1.6, 1.7, 1.6, SKIN);
  v.ellipsoid(-0.5, -4.5, 0.4, 1.9, 1.7, 1.9, SKIN_D); // fist round the bar
  return v;
}

/**
 * The dumbbell: a knurled bar with two plates a side, painted along the model's
 * X so it lies ACROSS the forearm the way a dumbbell is actually held.
 *
 * 0.6 units wide and 0.5 across the plates. A first pass at 1.2 wide was a
 * barbell held one-handed; this one reads as heavy because the plates are
 * thick, not because they are far apart.
 */
function buildDumbbell(): VoxelModel {
  const v = new VoxelModel();
  v.box(-3, 0, 0, 2, 0, 0, IRON_L);
  v.box(-1, 0, 0, 0, 0, 0, GRIP);
  for (const px of [-3, 2]) {
    v.ellipsoid(px, 0, 0, 0.45, 2.4, 2.4, IRON);
    v.set(px, 2, 0, IRON_L);
    v.set(px, -2, 0, IRON_L);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * Bake one model into a mesh, undo the baked fake sun, and hang the pieces on
 * the disposal list.
 *
 * `VoxelModel.build` always re-bases the mesh so its LOWEST voxel is at y = 0,
 * so a part painted from a joint DOWNWARD — the head with its beard, both arm
 * segments — comes back shifted up by its own overhang and has to be pushed
 * back down by exactly that. The shift is READ OFF the model rather than
 * written beside each part: it is `bounds().minY`, which is the same number
 * `build` used, and a hand-maintained copy of it is wrong the first time a
 * beard grows a voxel.
 */
function mkMesh(model: VoxelModel, out: NpcRig): THREE.Mesh {
  const baseY = model.bounds(true).minY;
  const mesh = model.build(S, true);
  const g = mesh.geometry;
  relight(
    (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
    (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
  );
  mesh.position.y = baseY * S;
  // Casts but does not receive, exactly like the hero and the beasts: a rig built
  // from separate parts a few centimetres apart shadows itself, and the band it
  // prints lands across the one part that has to read — his face.
  mesh.receiveShadow = false;
  mesh.castShadow = true;
  out.disposables.push(g, mesh.material as THREE.Material);
  return mesh;
}

function build(): NpcRig {
  const rig: NpcRig = {
    root: new THREE.Group(),
    parts: {},
    height: 2.0,
    radius: 0.55,
    solid: [],
    disposables: [],
    state: { attend: 0 },
  };

  const body = new THREE.Group();
  rig.root.add(body);

  const bodyModel = buildBody();
  body.add(mkMesh(bodyModel, rig));
  // THE COLLIDER IS THE BODY. Measured off the same voxels that were just
  // baked, in the same primitive a hut uses, and never authored as a number.
  rig.solid = measureFootprint(bodyModel, S);

  const head = new THREE.Group();
  head.position.set(0, NECK_Y, NECK_Z);
  head.add(mkMesh(buildHead(), rig));
  body.add(head);

  // One arm model, two arms. `sx` is +1 for his LEFT — the model faces +Z, so
  // his left hand is at +X and appears on the right of the screen to someone
  // standing in front of him, which is what facing a person looks like. (The
  // hero rig names its groups the other way round; his are mirrored.)
  const arms: Record<string, THREE.Group> = {};
  for (const [side, sx] of [
    ["L", 1],
    ["R", -1],
  ] as const) {
    const shoulder = new THREE.Group();
    shoulder.position.set(SHOULDER_X * sx, SHOULDER_Y, -0.02);
    shoulder.add(mkMesh(buildUpperArm(), rig));
    const elbow = new THREE.Group();
    // Outboard by NECK_Z's 2 cm, for NECK_Z's reason and not an anatomical one:
    // the forearm and the upper arm are two models on one joint whose offset is
    // a whole number of voxels in x, so their outer faces stood on the same
    // plane and fought down the outside of both arms. `sx` keeps him
    // symmetrical — each forearm moves outward, neither moves left.
    elbow.position.set(NECK_Z * sx, -UPPER_ARM, 0);
    elbow.add(mkMesh(buildForearm(), rig));
    shoulder.add(elbow);
    body.add(shoulder);
    arms[`arm${side}`] = shoulder;
    arms[`elbow${side}`] = elbow;
  }

  const weight = new THREE.Group();
  weight.position.set(0, -FOREARM, 0.04);
  weight.add(mkMesh(buildDumbbell(), rig));
  arms["elbowL"].add(weight);

  rig.parts = { body, head, ...arms, weight };
  return rig;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/**
 * ONE REP, in seconds.
 *
 * 4.6 s is slow on purpose. The brief is a STRAINED curl, not a pump, and the
 * shape below spends 1.4 s lifting, holds for 0.4 at the top, takes 1.8 to let
 * it back down — an eccentric longer than the concentric, which is what heavy
 * actually looks like — and rests for a second before the next one.
 */
const REP = 4.6;
const LIFT_END = 0.3;
const HOLD_END = 0.38;
const LOWER_END = 0.78;

/** Elbow angle with the weight down. Never locked out: he is holding iron. */
const EXT = 0.5;
/**
 * Elbow angle at the top of the rep, radians.
 *
 * 2.15 and not a full 2.5. The arc from 0.5 to 2.15 already carries the weight
 * from his thigh to his collarbone, which is the whole gesture, and it stops
 * short of the angle at which the inner plate — the arm is abducted 0.16, so
 * the bar's inboard end passes ~0.33 outside his ribs — would start crossing
 * the front of his own deltoid. Captured at 2.15 (_gain-b.png) the weight is
 * clearly at chest height and clearly not inside him.
 */
const FLEX = 2.15;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * The rep curve, 0 (weight down) to 1 (weight up).
 *
 * Every segment is a smoothstep, so the curve's slope is zero at each junction
 * and the whole thing is continuous in the FIRST derivative as well as the
 * value. That is the same standard `test-beastanim.mjs` holds the beast rigs to: the
 * fastest this moves is (1.5 / 0.30) / 4.6 = 1.09 of the range per second,
 * times a 1.65 rad range = 1.8 rad/s, i.e. 0.06 rad in a 30 fps frame and 0.12
 * at 15 fps — comfortably inside the ~0.35 rad ceiling a joint may move between
 * frames before it reads as a teleport rather than a movement.
 */
function repCurve(u: number): number {
  if (u < LIFT_END) {
    return smooth(u / LIFT_END);
  }
  if (u < HOLD_END) {
    return 1;
  }
  if (u < LOWER_END) {
    return 1 - smooth((u - HOLD_END) / (LOWER_END - HOLD_END));
  }
  return 0;
}

function animate(rig: NpcRig, ctx: NpcAnimCtx): void {
  const p = rig.parts;
  // A CONSTANT frequency, so multiplying the clock out is safe here — the
  // discontinuity `BeastAnimCtx.cycle` exists to avoid only appears when a rate
  // changes, and nothing about this rep ever speeds up.
  const u = (ctx.time / REP) % 1;
  const c = repCurve(u);
  // Two different loads. `c` is how high the weight is; `strain` peaks in the
  // MIDDLE of the movement, where the forearm is horizontal and the moment arm
  // is worst, which is where a real lifter's whole body starts helping.
  const strain = Math.sin(c * Math.PI);
  // Whether he is being spoken to, smoothed. The framework's flag is a hard
  // boolean at a range boundary, and posing straight off it would snap his chin
  // up the instant the player crosses 4.2 units away.
  rig.state.attend += ((ctx.attended ? 1 : 0) - rig.state.attend) * (1 - Math.exp(-6 * ctx.dt));
  const attend = rig.state.attend;

  const body = p["body"];
  // Breathing, plus a sink under the load: he settles into his hips at the
  // hardest part of the rep and stands back up as it comes down.
  body.position.y = Math.sin(ctx.time * 1.5) * 0.012 - strain * 0.03;
  // Counterweight. The iron is on his left (+X), so he leans away from it; a
  // positive rotation about Z tips the top of him toward -X.
  body.rotation.z = strain * 0.055;
  body.rotation.x = -c * 0.05;
  body.rotation.y = Math.sin(ctx.time * 0.43) * 0.03;

  const head = p["head"];
  // Chin down to watch the weight leave his hip, up as it arrives — and a
  // little further up when there is someone to look at.
  head.rotation.x = 0.14 - c * 0.2 - attend * 0.08;
  head.rotation.z = -strain * 0.05;
  // A slow scan of the camp that stops when he has company.
  head.rotation.y = Math.sin(ctx.time * 0.55) * 0.12 * (1 - attend);

  const armL = p["armL"];
  armL.rotation.x = -0.06 - c * 0.24;
  // Abduction: the elbow stays outboard of the ribs through the whole rep,
  // which is both how a dumbbell curl works and what keeps the plates off the
  // robe. Tightens slightly at the top as he squeezes.
  armL.rotation.z = 0.16 - strain * 0.04;
  p["elbowL"].rotation.x = -(EXT + (FLEX - EXT) * c);

  // The idle arm. Bent, thumb hooked near the satchel strap, with the faintest
  // sway so he is not a statue holding one moving limb.
  const armR = p["armR"];
  armR.rotation.x = 0.16 + Math.sin(ctx.time * 1.5) * 0.02;
  armR.rotation.z = -0.1;
  p["elbowR"].rotation.x = -0.85 - strain * 0.05;
}

// ---------------------------------------------------------------------------

/**
 * THE HALF OF HIM THAT IS CODE — a body and a dumbbell curl, and nothing else.
 *
 * Everything this record used to carry beside `build` and `animate` is now the
 * `npc:gain` asset in src/content/data/core.json, value for value: his id, his
 * display name, that he lives in the Encampment, that he wants to stand in the
 * MIDDLE of it (0 — the cart road ends there, so the placement search in
 * world/npc.ts walks him outward until his feet are off the carriageway and he
 * lands beside the fire), that he then stands ACROSS THE FIRE from wherever
 * that put him (he is the camp's one fixed face and the fire is what a visitor
 * walks toward, so you see him over the flames on the way in rather than
 * finding him beside you as you pass), and the one line he says.
 *
 * That line was `talk: () => ({ … })` and is a one-entry ORDERED LIST now — the
 * quest seam the old comment promised, expressed as data. See
 * src/content/types/npc.ts.
 *
 * Registered as `npc-body/gain` by the roster in world/npc.ts, which is the one
 * place a body is named.
 */
export const GAIN_BODY: NpcBody = { build, animate };
