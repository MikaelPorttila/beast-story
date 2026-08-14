/**
 * THE VILLAGERS — every character in the game who is a working person rather
 * than a silhouette. The three who live on the flying island (issue #68) and
 * Mera Ashgrove at Redbriar Mill (issue #149).
 *
 * ONE BODY BUILDER, FOUR CHARACTERS, and that is a decision about where the
 * variety should live rather than a shortcut. Gain (world/npc-gain.ts) is a
 * silhouette: a robe, a bald pate, a beard and a dumbbell, and every one of
 * those is a fact about HIM. These four are villagers, and what distinguishes
 * one villager from another at conversation distance is their colour, what they
 * are holding and what they are DOING with it — not their skeleton. So the
 * skeleton is written once and parameterised, and each of them differs in a
 * palette, a prop and an idle.
 *
 * The alternative was four copies of the same 200 lines diverging over time,
 * which is the thing this project says about forked constants everywhere else.
 * A character who genuinely needs a different body plan gets a file of his own,
 * exactly as Gain has one.
 *
 * THE Z-FIGHTING RULE APPLIES HERE TOO, and the offsets that answer it are the
 * same ones Gain's file argues at length: `VoxelModel.build` lays every face on
 * a multiple of the voxel scale re-based on the model's own bounds, so two
 * parts share a face grid in an axis exactly when the joint between them is a
 * whole number of voxels in that axis. `NECK_Z` and the forearms' outboard
 * nudge are that, stated. `bun tools/test-zfight.mjs` is what says whether it
 * is still true — it walks `NPC_BODIES`, so all of them are covered the moment
 * they are in the roster.
 */
import * as THREE from "three";
import { VoxelModel } from "../core/voxel";
import { relight } from "./props";
import { measureFootprint } from "./structures";
import type { NpcAnimCtx, NpcBody, NpcRig } from "./npc";

/** World units per voxel — the hero's and Gain's. A face needs 10 cm cells. */
const S = 0.1;

// -- proportions (world units) ---------------------------------------------
// Read by the builder AND the animator, so a joint cannot be in two places.
const SHOULDER_Y = 1.16;
/**
 * Shoulder half-width — and the 0.02 on the end of it is the z-fighting rule
 * again, not anatomy. At a flat 0.30 the joint is EXACTLY three voxels out, so
 * the arm's face grid and the body's coincide in x and the shell of the sleeve
 * fought the shell of the tunic down the outside of both arms (measured 0.0042
 * m2 on the gardener).
 *
 * A FIFTH OF A VOXEL, NOT A FIFTIETH. 0.302 was tried first and the seam did
 * not move: `test-zfight.mjs` calls two faces coincident within 0.004, so a
 * 0.002 part is still one plane as far as the depth buffer and the guard are
 * concerned. `NECK_Z`'s 0.02 is the size that works, and it is the same number
 * for the same reason in every axis this file parts.
 */
const SHOULDER_X = 0.32;
const NECK_Y = 1.3;
/** See the header: a fifth of a voxel, to part the head's z-grid from the body's. */
const NECK_Z = 0.02;
const UPPER_ARM = 0.34;
const FOREARM = 0.32;
/** How far inboard of the fist a held prop hangs. See the note at its use. */
const ELBOW_X = 0.05;
const ELBOW_Z = 0.05;
const PROP_X = 0.07;
/**
 * ...and how far up, which is the THIRD axis the same rule had to be applied
 * in. The lamplighter's pole is the only prop tall enough to reach the
 * shoulders, and its voxel tops landed on the same horizontal plane as the
 * tunic's — a +Y face, so neither the x nor the z part above could touch it
 * (measured 0.008 m2 at y = 1.4). Three centimetres in the hand, invisible.
 */
const PROP_Y = 0.03;

// -- shared palette --------------------------------------------------------
const SKIN = 0xd8a274;
const SKIN_D = 0xb8814f;
const BOOT = 0x4b3a2a;
const BELT = 0x6b4a2e;
const BUCKLE = 0xc9a24f;
const EYE = 0x2a2530;
const IRON = 0x6e7079;
const IRON_L = 0x9a9ca6;
const GLASS = 0xbfe4ef;
const FLAME = 0xffc247;
const WATER = 0x5fa8d8;
const LEAF = 0x6fae4a;
const LEATHER = 0x6b4a2e;
const SACK = 0xbda878; // undyed hessian
const SACK_D = 0x9a8659;
const FLOUR = 0xece4d2;

/** Everything one of these three differs by. */
interface Skin {
  /** Tunic, its shaded folds, and the trousers under it. */
  cloth: number;
  clothD: number;
  legs: number;
  hair: number;
  hairD: number;
  /** What they hold in the right hand, or null for empty hands. */
  prop: (() => VoxelModel) | null;
  /** How far forward the prop hangs from the fist, in world units. */
  propZ: number;
  /**
   * How far INBOARD of the fist it hangs, overriding `PROP_X`.
   *
   * Two of the three state one, and the reason is that a prop is a THIRD joint
   * out — fist, elbow, shoulder — so the offset that parts it from the arm
   * holding it is not the offset that parts it from the torso behind it, and
   * which of the two bites depends on the prop's own reach. The lamplighter's
   * pole runs past the tunic (0.01 m2 down the whole shaft at the shared 0.07)
   * and the pilot's spyglass swings into the flank at the bottom of his sweep
   * (0.0027). Both clear at 0.09; the gardener's can hangs in front of him and
   * never gets near the body, so it takes the shared value.
   *
   * These were found by RUNNING `bun tools/test-zfight.mjs`, which sweeps every
   * pose of every joint — not by reading the geometry. Change a prop's length
   * or a joint's offset and re-run it: the number that works is a property of
   * where the model's own bounds land on the voxel grid, and it is not the sort
   * of thing that can be reasoned out from the values here.
   */
  propX?: number;
  /**
   * The idle, as three numbers, because all three of these people are standing
   * still doing one small repeated thing and the difference between them is its
   * shape rather than its kind.
   *
   *   period   seconds for one repetition
   *   reach    radians the working shoulder swings through
   *   scan     radians of head sweep — a lookout scans, a gardener looks down
   */
  period: number;
  reach: number;
  scan: number;
  /** Resting pitch of the head. Negative looks up. */
  gaze: number;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * Torso, trousers, boots and belt — everything that does not move, and
 * therefore exactly the thing that blocks (see `NpcRig.solid`).
 *
 * The x and z bounds sum to -1 on both axes, which is the rule `VoxelModel`'s
 * centred mode and `measureFootprint` share: a model that obeys it has its mesh
 * and its collider on one origin with no fixup.
 */
function buildBody(s: Skin): VoxelModel {
  const v = new VoxelModel();
  // boots and legs, painted from the ground up
  v.box(-3, 0, -2, -1, 1, 1, BOOT);
  v.box(0, 0, -2, 2, 1, 1, BOOT);
  v.box(-3, 2, -2, -1, 5, 1, s.legs);
  v.box(0, 2, -2, 2, 5, 1, s.legs);
  // tunic: a touch wider than the hips so it reads as cloth over a body
  v.box(-4, 6, -2, 3, 12, 1, s.cloth);
  v.box(-4, 6, -2, 3, 6, 1, s.clothD); // hem in shade
  v.box(-4, 7, -3, 3, 11, -3, s.clothD); // the back, away from the sun
  v.box(-4, 8, -2, -4, 12, 1, s.clothD); // and the left flank
  // belt
  v.box(-4, 7, -3, 3, 7, 2, BELT);
  v.box(-1, 7, 2, 0, 7, 2, BUCKLE);
  // shoulders, filled out past the head's own width so the two silhouettes do
  // not meet on a shared plane in x — Gain's file argues this at `NECK_Z`.
  v.box(-4, 11, -2, 3, 12, 1, s.cloth);
  v.ellipsoid(-3.5, 12, -0.5, 1.6, 1.2, 1.8, s.cloth);
  v.ellipsoid(2.5, 12, -0.5, 1.6, 1.2, 1.8, s.cloth);
  // neck
  v.box(-1, 12, -1, 0, 13, 0, SKIN_D);
  return v;
}

/** Skull, hair and face, painted around the neck joint. */
function buildHead(s: Skin): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, 1.6, -0.5, 2.6, 2.8, 2.6, SKIN);
  // hair: a cap over the crown and down the back, stopping clear of the face
  v.ellipsoid(-0.5, 2.4, -1.0, 2.8, 2.4, 2.5, s.hair);
  v.ellipsoid(-0.5, 1.2, -2.2, 2.6, 2.2, 1.4, s.hairD);
  v.box(-3, 0, -3, 2, 1, -1, s.hairD);
  // eyes, one voxel each, set into the front face
  v.set(-2, 2, 2, EYE);
  v.set(1, 2, 2, EYE);
  return v;
}

function buildUpperArm(s: Skin): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -0.5, 0, 1.6, 1.5, 1.6, s.cloth);
  v.ellipsoid(-0.5, -2.2, 0, 1.5, 1.7, 1.5, s.clothD);
  v.ellipsoid(-0.5, -3.4, 0, 1.2, 1.1, 1.2, SKIN_D);
  return v;
}

function buildForearm(): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -1.2, 0, 1.4, 1.6, 1.4, SKIN);
  v.ellipsoid(-0.5, -3.0, 0.2, 1.5, 1.3, 1.5, SKIN_D); // the fist
  return v;
}

// -- the props -------------------------------------------------------------

/** A brass spyglass, painted along Z so it points the way the fist does. */
function buildSpyglass(): VoxelModel {
  const v = new VoxelModel();
  v.box(-1, -1, -3, 0, 0, 2, IRON);
  v.box(-2, -2, 2, 1, 1, 4, IRON_L);
  v.box(-2, -2, 4, 1, 1, 4, GLASS);
  return v;
}

/** A watering can: a body, a handle and a spout with a drop at its lip. */
function buildCan(): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -2, -0.5, 2.2, 2.0, 2.2, IRON);
  v.box(-2, -1, -1, 1, 0, 0, IRON_L);
  v.box(1, -3, 1, 2, -2, 3, IRON_L);
  v.set(2, -3, 4, WATER);
  v.set(-1, 1, -1, LEAF);
  return v;
}

/** A drove-warden's staff: a shaft with an iron crook and a strap at the grip. */
function buildCrook(): VoxelModel {
  const v = new VoxelModel();
  v.box(-1, -7, -1, 0, 5, 0, BELT);
  v.box(-1, 5, -1, 0, 7, 0, IRON);
  v.box(-1, 7, 0, 0, 8, 2, IRON);
  v.box(-1, 6, 2, 0, 7, 3, IRON_L);
  v.set(-1, -1, 1, LEATHER);
  return v;
}

/** An oar, blade down: shaft, throat, and the flat a boatwright is always planing. */
function buildOar(): VoxelModel {
  const v = new VoxelModel();
  v.box(-1, -6, -1, 0, 6, 0, BELT);
  v.box(-1, -9, -1, 0, -6, 1, IRON_L);
  v.set(-1, 6, 0, LEATHER);
  return v;
}

/** A grain sack, tied at the neck and slumped the way a full one does. */
function buildSack(): VoxelModel {
  const v = new VoxelModel();
  v.ellipsoid(-0.5, -2.4, 0, 2.0, 2.2, 1.8, SACK);
  v.ellipsoid(-0.5, -3.4, 0.2, 1.8, 1.4, 1.6, SACK_D);
  v.box(-1, -0.5, -1, 0, 0, 0, BELT); // the tie
  v.set(-1, -1, 2, FLOUR); // what has got out of it
  return v;
}

/** A pole lantern: a shaft with a caged flame at the top of it. */
function buildLantern(): VoxelModel {
  const v = new VoxelModel();
  v.box(-1, -6, -1, 0, 4, 0, BELT);
  v.box(-2, 4, -2, 1, 4, 1, IRON);
  v.box(-2, 5, -2, 1, 8, 1, IRON);
  // The flame is painted into the SAME model as its cage, unlike a settlement's
  // fires — a hand prop is one mesh on one material, so there are no two
  // accumulators here for a face to be coincident across. It is a lit-looking
  // colour rather than an emissive: an NPC rig is baked onto its own material
  // and adding a second one to every character to glow one voxel is not a
  // trade this needs. See the GLOW_PART note in world/town-parts.ts for the
  // case where it genuinely matters.
  v.box(-1, 5, -1, 0, 7, 0, FLAME);
  return v;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** Bake one model, undo the baked fake sun, and register it for disposal. */
function mkMesh(model: VoxelModel, out: NpcRig): THREE.Mesh {
  const mesh = model.build(S, true);
  const g = mesh.geometry;
  relight(
    (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array,
    (g.getAttribute("color") as THREE.BufferAttribute).array as Float32Array,
  );
  // `build` re-bases the mesh so its LOWEST voxel sits at y = 0, so a part
  // painted DOWNWARD from its joint comes back lifted by its own overhang and
  // has to be pushed back by exactly that. Read off the model, never written
  // down beside the part — the same argument npc-gain.ts makes.
  mesh.position.y = model.bounds(true).minY * S;
  mesh.receiveShadow = false;
  mesh.castShadow = true;
  out.disposables.push(g, mesh.material as THREE.Material);
  return mesh;
}

function buildRig(s: Skin): NpcRig {
  const rig: NpcRig = {
    root: new THREE.Group(),
    parts: {},
    height: 1.85,
    radius: 0.45,
    solid: [],
    disposables: [],
    state: { attend: 0, walk: 0, stride: 0 },
  };

  const body = new THREE.Group();
  rig.root.add(body);
  const bodyModel = buildBody(s);
  body.add(mkMesh(bodyModel, rig));
  // THE COLLIDER IS THE BODY, measured off the voxels that were just baked and
  // never authored as a number.
  rig.solid = measureFootprint(bodyModel, S);

  const head = new THREE.Group();
  head.position.set(0, NECK_Y, NECK_Z);
  head.add(mkMesh(buildHead(s), rig));
  body.add(head);

  const parts: Record<string, THREE.Object3D> = { body, head };
  for (const [side, sx] of [
    ["L", 1],
    ["R", -1],
  ] as const) {
    const shoulder = new THREE.Group();
    shoulder.position.set(SHOULDER_X * sx, SHOULDER_Y, -0.02);
    shoulder.add(mkMesh(buildUpperArm(s), rig));
    const elbow = new THREE.Group();
    // Outboard by a fifth of a voxel, each arm away from the middle: the two
    // segments are one joint apart in x on a whole number of cells, so their
    // outer faces stood on the same plane. Gain's file states the same fix.
    elbow.position.set(ELBOW_X * sx, -UPPER_ARM, ELBOW_Z);
    elbow.add(mkMesh(buildForearm(), rig));
    shoulder.add(elbow);
    body.add(shoulder);
    parts[`arm${side}`] = shoulder;
    parts[`elbow${side}`] = elbow;
  }

  if (s.prop) {
    const held = new THREE.Group();
    // HALF A VOXEL, and it has to be a different number from the shoulder's.
    // The prop's grid has to be parted from the FOREARM holding it (0.05 away)
    // and from the BODY behind it, which is a second joint up: at `NECK_Z` the
    // prop would sit 0.30 from the body's origin, three whole cells, and the
    // lamplighter's pole went straight back to fighting his tunic (0.01 m2).
    // 0.05 leaves 0.27 to the body, parted by 0.03 — clear of the guard's
    // 0.004 threshold on both joints at once.
    held.position.set(s.propX ?? PROP_X, -FOREARM + PROP_Y, s.propZ);
    held.add(mkMesh(s.prop(), rig));
    parts["elbowR"].add(held);
    parts["prop"] = held;
  }

  rig.parts = parts;
  return rig;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * One idle, shaped by `Skin`.
 *
 * The curve is a smoothstep out and a smoothstep back, so its slope is zero at
 * both ends and the motion is continuous in the first derivative as well as the
 * value — the standard `test-beastanim.mjs` holds every rig in the game to. At
 * the fastest of the three periods (3.4 s) the working shoulder covers 0.55 rad
 * in 1.36 s, i.e. 0.013 rad in a 30 fps frame, two orders under the ~0.35 rad
 * ceiling at which a joint reads as teleporting.
 *
 * A CONSTANT frequency, so multiplying the clock out is safe: the
 * discontinuity `BeastAnimCtx.cycle` exists to prevent only appears when a rate
 * changes, and nothing here ever speeds up.
 */
function animateWith(s: Skin, rig: NpcRig, ctx: NpcAnimCtx): void {
  const p = rig.parts;
  const u = (ctx.time / s.period) % 1;
  const c = u < 0.5 ? smooth(u * 2) : 1 - smooth((u - 0.5) * 2);

  // Attention, smoothed. The framework's flag is a hard boolean at a range
  // boundary and posing straight off it would snap the chin up the instant the
  // player crosses the line.
  rig.state.attend += ((ctx.attended ? 1 : 0) - rig.state.attend) * (1 - Math.exp(-6 * ctx.dt));
  const attend = rig.state.attend;

  const body = p["body"];
  body.position.y = Math.sin(ctx.time * 1.4) * 0.011;
  body.rotation.y = Math.sin(ctx.time * 0.37) * 0.04 * (1 - attend);
  body.rotation.x = c * 0.03;

  const head = p["head"];
  // The work is what they look at until somebody turns up, and then it is you.
  head.rotation.x = s.gaze * (1 - attend) - attend * 0.06 + c * 0.05;
  head.rotation.y = Math.sin(ctx.time * ((Math.PI * 2) / s.period)) * s.scan * (1 - attend);
  head.rotation.z = Math.sin(ctx.time * 0.61) * 0.02;

  // The working arm does the job; the other one keeps its own slow time, so
  // neither of them is ever perfectly still and they are never in step.
  const armR = p["armR"];
  armR.rotation.x = -0.12 - c * s.reach;
  armR.rotation.z = -0.11;
  p["elbowR"].rotation.x = -0.5 - c * (s.reach * 0.6);

  const armL = p["armL"];
  armL.rotation.x = 0.1 + Math.sin(ctx.time * 1.1) * 0.03;
  armL.rotation.z = 0.12;
  p["elbowL"].rotation.x = -0.55 - Math.sin(ctx.time * 1.1 + 0.7) * 0.05;

  // THE WALK, layered over the idle for a follower (issue #234). Stride is
  // smoothed so stopping settles the arms instead of freezing them mid-swing,
  // and the phase advances with his own speed — feet and ground agree at any dt.
  const stride = Math.min(1, (ctx.speed ?? 0) / 4.5);
  rig.state.stride += (stride - rig.state.stride) * (1 - Math.exp(-8 * ctx.dt));
  const s2 = rig.state.stride;
  if (s2 > 0.01) {
    rig.state.walk += (ctx.speed ?? 0) * 0.55 * Math.PI * ctx.dt;
    const w = rig.state.walk;
    body.position.y += Math.abs(Math.sin(w)) * 0.035 * s2;
    body.rotation.x += 0.07 * s2;
    armR.rotation.x += Math.sin(w) * 0.5 * s2;
    armL.rotation.x -= Math.sin(w) * 0.5 * s2;
  }
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------

function bodyFor(s: Skin): NpcBody {
  return {
    build: () => buildRig(s),
    animate: (rig, ctx) => animateWith(s, rig, ctx),
  };
}

/** The helmsman: navy coat, spyglass, watches the horizon go by. */
export const SKY_PILOT_BODY = bodyFor({
  cloth: 0x2f4a72,
  clothD: 0x233858,
  legs: 0x3b3f4a,
  hair: 0x4a3a2c,
  hairD: 0x35281d,
  prop: buildSpyglass,
  propZ: 0.16,
  propX: 0.09,
  period: 5.6,
  reach: 0.95,
  scan: 0.34,
  gaze: -0.1,
});

/** The gardener: green apron, watering can, works the deck's one green acre. */
export const SKY_GARDENER_BODY = bodyFor({
  cloth: 0x5f7d47,
  clothD: 0x475f36,
  legs: 0x6b5a41,
  hair: 0xa8823f,
  hairD: 0x82632c,
  prop: buildCan,
  propZ: 0.14,
  period: 3.4,
  reach: 0.55,
  scan: 0.16,
  gaze: 0.22,
});

/** The lamplighter: ochre coat, pole lantern, keeps the rim lights burning. */
export const SKY_LAMPLIGHTER_BODY = bodyFor({
  cloth: 0x8a6134,
  clothD: 0x694723,
  legs: 0x4a4239,
  hair: 0xd9d2c4,
  hairD: 0xb0a89a,
  prop: buildLantern,
  propZ: 0.17,
  propX: 0.09,
  period: 4.8,
  reach: 0.75,
  scan: 0.24,
  gaze: -0.04,
});

/**
 * WARDEN SELA COIL — Stonewatch's drove warden (issue #151), and the one person
 * in Act 1 who already knows what the shards are.
 *
 * Watch-green over a leather jerkin, iron-grey hair cropped short, and a
 * drove-warden's crook she leans on rather than works with — the longest reach
 * of the four and the slowest period, because she is watching a herd she can no
 * longer trust and everyone else here is doing a job.
 *
 * She reappears in Act 2 as `npc:coil/kelphold` (game-story.md §2), which is a
 * second PLACEMENT of this body and this display name, not a second character.
 */
export const COIL_BODY = bodyFor({
  cloth: 0x4f6b4a,
  clothD: 0x3a5137,
  legs: 0x4a4239,
  hair: 0xb9b4a8,
  hairD: 0x8d887c,
  prop: buildCrook,
  propZ: 0.15,
  propX: 0.09,
  period: 6.2,
  reach: 0.3,
  scan: 0.4,
  gaze: -0.08,
});

/**
 * MERA ASHGROVE — Redbriar's miller (issue #149). Flour-pale apron over a dark
 * working dress, a sack of grain on the hip, and the shortest reach of the four:
 * she is shifting a weight from the floor to a hopper, not sweeping a horizon.
 * Her eyes are on the sack until somebody walks up, which `gaze` says.
 */
/**
 * BRACK TULLEY — Saltrest's boatwright, met keeping Kelphold's drowned market
 * (issue #154). Tar-dark oilskin over salt-bleached legs, an oar he is never
 * without, and a shipwright's slow, deliberate reach: he is fairing a plank in
 * his head even when he is talking to you. The `boatwright` body — a working
 * villager, not a bespoke rig, exactly as the cast note in npc.ts asks.
 */
export const BOATWRIGHT_BODY = bodyFor({
  cloth: 0x3d3a35,
  clothD: 0x2b2925,
  legs: 0x8d8471,
  hair: 0x3a3632,
  hairD: 0x2a2724,
  prop: buildOar,
  propZ: 0.15,
  propX: 0.09,
  period: 5.0,
  reach: 0.6,
  scan: 0.2,
  gaze: 0.12,
});

export const MERA_BODY = bodyFor({
  cloth: 0xd8cdb4,
  clothD: 0xb3a68a,
  legs: 0x4d3f4f,
  hair: 0x6b4526,
  hairD: 0x4c2f18,
  prop: buildSack,
  propZ: 0.13,
  propX: 0.09,
  period: 4.2,
  reach: 0.42,
  scan: 0.14,
  gaze: 0.2,
});
