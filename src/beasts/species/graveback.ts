import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// Graveback — issue #117. Undead quadruped: bone skull, its own ribs grown out through its
// back, a grave-shroud over the shoulders. Model faces +Z, root at ground level.
// Voxel scale 0.07, not the roster's 0.1: the rib LATTICE and the skull's socket, nasal void
// and tooth line do not survive at one or two cells; 0.045 turns a leg bone into a thread.

const S = 0.07;

// Flesh is a WARM slate: shaded faces are lit only by blue sky bounce, so neutral grey renders
// blue. Lit crest to deep shadow is ~2.6:1 — raise every tone and you get a beige lump.
const C = {
  flesh: 0x7a828f,
  fleshLt: 0x9aa2b4,
  fleshDk: 0x5e6472,
  fleshDp: 0x474d5a,
  bone: 0xcdbf98,
  boneLt: 0xe6dcc0,
  boneDk: 0xb5a683,
  boneDp: 0x8e805f,
  socket: 0x241f18,      // dark brown, never black: black holes the silhouette
  glow: 0x3fd8e2,
  glowLt: 0xa8f2f6,
  cloth: 0x7b3a46,
  clothLt: 0x99505c,
  clothDk: 0x5a2932,
} as const;

// Emissive stays low (bloom is downstream), and the EYES run LOWER than the body seams: at
// body intensity the bloom smeared them past the socket and erased the recess.
const GLOW = 0.45;
const EYE_GLOW = 0.38;

// Shared between buildRig() and animate(): a number in both is a pose that drifts. BODY_Y
// 0.32, not 0.42 — half the height was daylight and the legs read as stove pipes.
const BODY_Y = 0.32;       // underside of the barrel, above the root
const HEAD_Y = 0.20;
const HEAD_Z = 0.28;       // the head carries FORWARD and low, at knee height
const HEAD_PITCH = 0.22;
const LEG_Y = 0.32;
const TAIL_UP = 0.25;

/**
 * Three tenths of a voxel, and it is why this rig is seam-free. `build` puts every face on a
 * multiple of S re-based on the model's own bounds, so two parts share one world grid whenever
 * their joint is a whole multiple of S. Not a HALF: that cancels against `center = true`'s own
 * re-basing on an even span and can put two walls back on one plane. 21 mm on a metre-tall
 * animal, and a parting that cancels its parent's just moves the pair one link on.
 */
const JOINT_PART = S * 0.3;

export const skills: SkillDef[] = [
  {
    id: 'graveback.bonecrush',
    nameKey: 'skill.graveback.bonecrush.name',
    descriptionKey: 'skill.graveback.bonecrush.desc',
    element: 'shadow',
    targeting: 'melee',
    cost: 5,
    cooldown: 1.6,
    power: 17,
    range: 2.6,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'graveback.grave-howl',
    nameKey: 'skill.graveback.grave-howl.name',
    descriptionKey: 'skill.graveback.grave-howl.desc',
    element: 'shadow',
    targeting: 'aoe',
    cost: 14,
    cooldown: 6,
    power: 23,
    range: 6,
    learnAtLevel: 5,
    castAnim: 'cast',
  },
  {
    id: 'graveback.rib-shard',
    nameKey: 'skill.graveback.rib-shard.name',
    descriptionKey: 'skill.graveback.rib-shard.desc',
    element: 'shadow',
    targeting: 'projectile',
    cost: 16,
    cooldown: 7,
    power: 30,
    range: 15,
    storePrice: 240,
    castAnim: 'attack',
  },
  {
    id: 'graveback.barrow-tide',
    nameKey: 'skill.graveback.barrow-tide.name',
    descriptionKey: 'skill.graveback.barrow-tide.desc',
    element: 'shadow',
    targeting: 'beam',
    cost: 26,
    cooldown: 13,
    power: 48,
    range: 12,
    storePrice: 420,
    castAnim: 'special',
  },
];

// EVERY PART'S CELL SPAN IS SYMMETRIC IN X: `build(center = true)` re-bases on the bounding box, so a lopsided span lands
// half a cell off its group's origin — invisible in source, obvious on a pair. Asymmetric detail stays INSIDE the span.

/**
 * The arc ONE rib takes, as [y, dz] steps out from the spine — a curve in the Y/Z plane,
 * because a quadruped is read broadside and a hoop over the back is edge-on there (a mohawk).
 * Four cells of Z over six of Y, or it is a stave. Hand-listed so every step is
 * face-connected: a diagonal-only staircase bakes as loose cubes.
 */
const RIB: ReadonlyArray<readonly [number, number]> = [
  [7, 0], [7, 1], [6, 1], [6, 2], [5, 2], [5, 3], [4, 3], [3, 3], [2, 3], [1, 3],
];

function ribArc(v: VoxelModel, cz: number): void {
  for (const sx of [1, -1]) {
    for (let i = 0; i < RIB.length; i++) {
      const [y, dz] = RIB[i];
      const tone = i < 2 ? C.boneLt : i < 6 ? C.bone : C.boneDk;
      // x = 5 is INSIDE the hide (the barrel reaches |x| = 5), x = 6 stands proud. Against a
      // barrel that reaches 5 at one height only, an arc touches at a single cell and the flank
      // grows a picket fence: face-connected is not seated, and test-zfight checks the first.
      v.set(sx * 5, y, cz + dz, tone);
      if (i < 5) v.set(sx * 6, y, cz + dz, tone);
    }
    v.setEmissive(sx * 5, 7, cz, C.glow, GLOW);
  }
}

/**
 * A wrap of shroud-cloth: a closed band round a limb. A band is a RING, so the limb has to run
 * THROUGH its rows — a wrap above where the limb stops is cells joined only at their diagonals,
 * which build() bakes as a floating hoop.
 */
function wrap(v: VoxelModel, y: number, w: number, d: number, rows = 2): void {
  for (let r = 0; r < rows; r++) {
    for (let x = -w; x <= w; x++) {
      for (let z = -d; z <= d; z++) {
        if (Math.abs(x) < w && Math.abs(z) < d) continue;
        v.set(x, y + r, z, r === rows - 1 ? C.clothLt : C.cloth);
      }
    }
  }
}

/**
 * The barrel in ONE grid: nothing back here moves relative to anything else, and build() drops
 * the faces between touching cells, so a coincident pair inside one model is impossible.
 */
function buildTorso(): THREE.Mesh {
  const v = new VoxelModel();

  v.ellipsoid(0, 4.0, -1.0, 5.8, 3.6, 8.4, C.flesh);
  // A withers HUMP behind the skull, never a collar. No erase in VoxelModel, so the guard is
  // arithmetic: the mass must end behind HEAD_Z + (skull front cell) * S = 0.58; it ends at 0.49.
  v.ellipsoid(0, 5.2, 3.4, 5.4, 3.8, 3.0, C.flesh);   // withers
  v.ellipsoid(0, 3.8, -6.6, 5.2, 3.4, 3.4, C.flesh);
  rimTop(v, C.fleshLt, -5, 5, 6, 9, -11, 10);
  shadeUnder(v, C.fleshDp, -5, 5, 0, 1, -7, 6);

  const seams: Array<[number, number, number]> = [
    [5, 5, -2], [5, 4, -3], [5, 4, -4],
    [5, 3, -6], [5, 2, -7],
    [4, 5, -10], [4, 4, -10],
  ];
  for (const [x, y, z] of seams) {
    for (const sx of [1, -1]) v.setEmissive(sx * x, y, z, C.glow, GLOW * 0.55);
  }

  const plates: Array<[number, number, number]> = [
    [0, 7, -7], [2, 6, -9],
  ];
  for (const [x, y, z] of plates) {
    for (const sx of x === 0 ? [1] : [1, -1]) {
      v.box(sx * x, y, z, sx * x, y + 1, z, C.bone);
      v.set(sx * x, y + 1, z, C.boneLt);
    }
  }

  // Three a side, four apart for an arc three cells deep — closer and the flank is a solid
  // sheet, and a cage is the GAPS. BEHIND the shroud, and rooted low on the flank or only their
  // top cells clear the hide and three ribs are a mohawk.
  ribArc(v, -1);
  ribArc(v, -5);
  ribArc(v, -9);

  const capTop = [7, 8, 8, 7];
  for (let i = 0; i < 4; i++) {
    const z = 1 - i;
    const w = i === 0 ? 3 : 4;
    for (let x = -w; x <= w; x++) v.set(x, capTop[i], z, i >= 2 ? C.clothLt : C.cloth);
  }
  const fall = [3, 6, 2, 5];
  for (let i = 0; i < fall.length; i++) {
    const z = 1 - i;
    const topY = capTop[i];
    for (const sx of [1, -1]) {
      for (let d = 0; d < fall[i]; d++) {
        const y = topY - d;
        v.set(sx * 5, y, z, d === fall[i] - 1 ? C.clothDk : C.cloth);
      }
      v.set(sx * 5, topY, z, C.clothLt);
    }
  }

  for (let x = -5; x <= 5; x++) {
    for (let z = -3; z >= -4; z--) {
      for (let y = 1; y <= 6; y++) if (v.has(x, y, z)) v.set(x, y, z, y >= 5 ? C.clothLt : C.cloth);
    }
  }

  // No y offset: build() zeroes the mesh on its lowest cell and the body group's BODY_Y lifts the barrel.
  return v.build(S, true);
}

/**
 * The skull as one mesh; only the mandible articulates.
 *
 * THREE TONES ON THE FACE: lit cheekbones, half-value lids and alternating teeth came back as a
 * chequer that read as a corrupted texture. Bone, two holes, one tooth line.
 */
function buildSkull(): THREE.Mesh {
  const v = new VoxelModel();

  // NINE across against the barrel's eleven, TAPERED so the brow recedes. The ninth column is
  // not decoration: the socket reaches |x| = 3, and on a seven-wide cranium that cell is the
  // skull's outer WALL, which shows dark from the flank as a hole through the head.
  for (let y = 2; y <= 8; y++) {
    const w = y >= 8 ? 2 : y >= 7 ? 3 : 4;
    const front = y >= 7 ? 2 : 3;
    v.box(-w, y, -4, w, y, front, C.bone);
  }
  for (let z = -4; z <= 2; z++) v.set(0, 8, z, C.boneDk);
  v.box(-2, 1, 2, 2, 4, 5, C.bone);
  v.box(-2, 0, 3, 2, 0, 5, C.bone);
  rimTop(v, C.boneLt, -4, 4, 7, 8, -4, 5);
  shadeUnder(v, C.boneDk, -4, 4, 0, 1, -4, 5);

  for (const [y, z] of [[8, 0], [7, 1], [7, 2], [6, 3]] as const) {
    v.setEmissive(0, y, z, C.glow, GLOW);
  }

  // The sockets need WALLS: no erase in VoxelModel, so a recess is built by standing the bone
  // either side proud — the nasal ridge at x = 0 and these cheek ridges at |x| = 4. Without them
  // the socket is a dark rectangle painted on a flat face.
  for (const sx of [1, -1]) {
    for (let y = 4; y <= 6; y++) v.set(sx * 4, y, 4, C.bone);
    v.set(sx * 4, 6, 4, C.boneLt);
  }
  for (const sx of [1, -1]) {
    for (let d = 1; d <= 4; d++) {
      for (let y = 4; y <= 6; y++) v.set(sx * d, y, 3, C.socket);
    }
  }
  // Rows 4-6, ABOVE the muzzle: lower, the inner half of each iris sat inside the snout with its
  // faces culled as interior and the eyes did not light. TWO iris columns in a socket four wide —
  // one column is 11% of the face, and an iris that fills its socket reads as ski goggles.
  eyes2x2(v, {
    inner: 2, width: 2, y: 5, faceZ: 3,
    iris: C.glow, glow: EYE_GLOW, shine: C.glowLt,
  });
  // Nasal ridge PROUD for all three rows: flush, the two sockets bridge into one dark band.
  for (let y = 4; y <= 6; y++) {
    v.set(0, y, 3, C.boneLt);
    v.set(0, y, 4, C.boneLt);
  }
  // Brow FLUSH and short of the temples (wall to wall is a headband): the camera looks down at a
  // metre-tall animal, so relief here puts the eye line in the brow's shadow.
  for (let x = -2; x <= 2; x++) v.set(x, 7, 3, C.boneDk);

  // Nasal slot: ONE column with a clear row of bone before the tooth line — three cells over one
  // is a T, and a T in a face reads as a keyhole. Teeth hang IN a cut gap.
  v.set(0, 5, 5, C.socket);
  v.set(0, 4, 5, C.socket);
  v.set(0, 3, 5, C.boneDk); // one shaded row, so the slot is seated
  for (let x = -2; x <= 2; x++) {
    v.set(x, 1, 5, C.socket);
    if (x % 2 === 0) v.set(x, 1, 6, C.boneLt);
  }

  // Cheek spurs jut FORWARD and DOWN: sideways they were the widest thing on the head, and the
  // skull rides between the forelegs — a clearance the gait's 3% squash sweeps through.
  for (const sx of [1, -1]) {
    v.box(sx * 4, 0, 1, sx * 4, 2, 4, C.bone);
    v.box(sx * 4, 2, 1, sx * 4, 2, 4, C.boneLt);
    v.set(sx * 4, 0, 4, C.boneDk);
    v.set(sx * 4, 0, 1, C.boneDk);
  }

  for (const sx of [1, -1]) {
    v.box(sx * 4, 7, -2, sx * 4, 10, 0, C.bone);
    v.set(sx * 4, 10, -1, C.boneLt);
    v.set(sx * 4, 7, -2, C.boneDp);
  }

  // Tapered tusk, one step in y per step in z so the line is continuous, and two z per y up the
  // top half so it lies back rather than standing as a notched chimney.
  const spine: Array<[number, number, number]> = [
    [9, -2, 1], [10, -3, 1], [10, -4, 1], [11, -5, 1], [11, -6, 0], [12, -7, 0],
  ];
  for (const [y, z, w] of spine) {
    v.box(-w, y, z, w, y, z, C.bone);
    v.set(0, y, z, C.boneLt);
  }
  for (let x = -1; x <= 1; x++) {
    v.set(x, 9, -1, C.clothDk);
    v.set(x, 10, -2, C.cloth);
  }
  v.set(0, 9, -2, C.clothDk);

  const m = v.build(S, true);
  m.position.y = -3 * S;
  return m;
}

/** The mandible, on its own hinge so the jaw can drop for the howl. */
function buildJaw(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-2, 0, 0, 2, 1, 5, C.bone);
  rimTop(v, C.boneLt, -2, 2, 1, 1, 0, 5);
  shadeUnder(v, C.boneDk, -2, 2, 0, 0, 0, 5);
  for (let x = -2; x <= 2; x++) v.set(x, 1, 5, C.boneDp);
  return v.build(S, true);
}

/**
 * A leg. `front` picks the shoulder or the haunch; `dir` only moves a detail INSIDE the
 * symmetric span. Three cells across with a longer paw so it has a direction — thinner vanished
 * at play distance, because a limb is read against the BODY behind it, not a grey card.
 */
function buildLeg(front: boolean, dir: number): THREE.Mesh {
  const v = new VoxelModel();
  // The top runs FOUR cells past the hip pivot: at one, a 0.6 rad swing opened daylight between
  // shoulder and barrel. A limb stays buried through its whole arc.
  const top = front ? 10 : 9;
  v.box(-1, 1, -1, 1, top, 1, C.flesh);
  // Rounded, not a boxy step: a box leaves one long DOWN-facing ledge for the barrel's bobbing
  // underside to meet, while an ellipsoid's staircase underside presents no plane at all.
  v.ellipsoid(0, top - 2.0, front ? -0.3 : -0.6, 2.4, 2.6, 2.4, C.flesh);
  if (!front) v.box(-1, 1, -2, 1, 3, -2, C.flesh);
  rimTop(v, C.fleshLt, -2, 2, top - 1, top + 2, -3, 3);
  shadeUnder(v, C.fleshDk, -2, 2, 1, 1, -3, 3);

  // Claws two cells deep on a solid base: single cells read as loose cubes from behind.
  v.box(-1, 0, -1, 1, 0, 2, C.flesh);
  v.box(-1, 0, 2, 1, 0, 2, C.fleshDp);
  v.box(-1, 0, 3, 1, 0, 3, C.boneDk);
  for (const x of [-1, 0, 1]) v.set(x, 0, 4, C.bone);
  v.set(0, 0, 4, C.boneLt);
  v.box(-1, 0, -2, 1, 0, -2, C.fleshDp);

  v.box(dir, 5, -1, dir, 7, 0, C.bone);
  v.set(dir, 7, -1, C.boneLt);
  wrap(v, 1, 1, 1, 2);

  const m = v.build(S, true);
  // -LEG_Y, not the leg's own height: build() zeroes on the lowest cell, so subtracting the hip
  // height puts the PAW on the ground whatever the leg is made of.
  m.position.y = -LEG_Y;
  return m;
}

/**
 * One tail vertebra, tapering along the chain — and NO TWO LINKS ARE THE SAME SHAPE, which is a
 * rendering decision: identical blocks end to end agree on their side walls, end caps and
 * top/bottom planes, and a parting at one joint is inherited by the child and cancels, so the
 * reported pair moves one link along. Four links, because five leaves one pair identical.
 */
function buildTailSeg(i: number): THREE.Mesh {
  const v = new VoxelModel();
  const w = i === 0 ? 2 : i < 3 ? 1 : 0;
  const len = 4 - i;
  // ALTERNATE links carry the third row: three widths over four links means two neighbours share
  // one, and height is the axis with a spare degree of freedom.
  const n = Math.max(w - 1, 0);
  v.box(-n, 0, -len, n, 0, 0, C.bone);
  v.box(-w, 1, -len, w, 1, 0, C.bone);
  if (w > 0 && i % 2 === 0) v.box(-n, 2, -len, n, 2, 0, C.bone);
  // TWO tones and no more: five values on a five-cell block came back as a light/dark grid.
  rimTop(v, C.boneLt, -w, w, 1, 2, -len, 0);
  v.box(-w, 1, -len, w, 1, -len, C.boneDp);
  // Wraps painted ONTO the vertebra's own cells: a band reaching past the block it is tied to
  // leaves cells joined to nothing, which bakes as a floating hoop.
  if (i % 2 === 0) {
    for (let x = -w; x <= w; x++) {
      for (const z of [-2, -1]) {
        if (v.has(x, 0, z)) v.set(x, 0, z, C.cloth);
        v.set(x, 1, z, z === -1 ? C.clothLt : C.cloth);
        if (v.has(x, 2, z)) v.set(x, 2, z, C.cloth);
      }
      if (v.has(x, 1, 0)) v.set(x, 1, 0, C.clothDk);
    }
  }
  const m = v.build(S, true);
  // The per-link stagger — see above. x too, because the chain yaws link-by-link and a yaw
  // difference only separates two side walls while it is non-zero.
  m.position.z = -(2.5 + i * 0.2) * S;
  m.position.y = i * 0.17 * S;
  m.position.x = i * 0.13 * S;
  return m;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;
  body.add(buildTorso());

  const head = new THREE.Group();
  // Head parted in z, and ONE step in x, not two: an x parting is signed one way, so two steps
  // showed the skull off the shroud's centreline.
  head.position.set(JOINT_PART, HEAD_Y, HEAD_Z + JOINT_PART);
  head.rotation.x = HEAD_PITCH;
  head.add(buildSkull());
  body.add(head);
  parts.head = head;

  const jaw = new THREE.Group();
  // Parted in x AND z: the mandible matches the muzzle's width and the cranium's depth, and it SWINGS through both planes.
  jaw.position.set(JOINT_PART, -2 * S, -JOINT_PART);
  jaw.add(buildJaw());
  head.add(jaw);
  parts.jaw = jaw;

  let hook: THREE.Object3D = body;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Group();
    // Parted in x at the root, in y at every link, ALTERNATING in x and z down the chain:
    // consecutive vertebrae meet end to end, and an un-alternated parting is inherited and
    // cancels, which is how a chain reports a pair at nearly every joint.
    const flip = i % 2 === 1 ? 1 : -1;
    seg.position.set(i === 0 ? JOINT_PART : flip * JOINT_PART,
      i === 0 ? 0.12 : JOINT_PART,
      (i === 0 ? -0.60 - JOINT_PART : -0.20 + flip * JOINT_PART));
    seg.rotation.x = i === 0 ? TAIL_UP : 0.10;
    seg.add(buildTailSeg(i));
    hook.add(seg);
    hook = seg;
    parts[`tail${i + 1}`] = seg;
  }

  // Legs hang off the ROOT so the barrel can squash on a footfall without dragging the feet.
  const mkLeg = (name: string, front: boolean, x: number, z: number): void => {
    const g = new THREE.Group();
    const dir = Math.sign(x);
    // The FRONT pair takes two steps of parting, the back pair one: the skull rides between the
    // forelegs, so cheekbone and foreleg walls are within a cell for the whole idle.
    g.position.set(x + dir * JOINT_PART * (front ? 2 : 1), LEG_Y, z);
    g.add(buildLeg(front, dir));
    root.add(g);
    parts[name] = g;
  };
  // 0.135 is the one number here chosen by the seam guard rather than the eye: a foreleg must
  // clear the hide, the ribs, the hind leg and the skull's ear plate at once, and the barrel
  // SCALES with the gait's squash. A wider stance needs the SKULL's clearance widened first,
  // i.e. a narrower cranium — a change to the part that took longest to make read.
  mkLeg('legFR', true, 0.135, 0.40);
  mkLeg('legFL', true, -0.135, 0.40);
  // The back pair stands WIDER: at 0.24 the two legs on a side landed a millimetre apart in x.
  mkLeg('legBR', false, 0.28, -0.42);
  mkLeg('legBL', false, -0.28, -0.42);

  // 1.40 to the horn tip, but `height` is what the framework aims at and floats in water.
  return { root, parts, height: 1.15, radius: 0.50 };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

// Integrated cycle slots — see BeastAnimCtx.cycle(). Constant frequencies read the free clock.
const GAIT = 0;
const TAIL = 1;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  let bodyY = BODY_Y + Math.sin(t * 1.3) * 0.008;
  let bodyZ = 0;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = 0;
  let sq = 1;
  let headRX = HEAD_PITCH + Math.sin(t * 1.3 + 0.7) * 0.03;
  let headRY = Math.sin(t * 0.37) * 0.26;
  let headRZ = Math.sin(t * 0.53) * 0.05;
  let headY = HEAD_Y;
  let jawOpen = 0.05 + Math.sin(t * 1.3) * 0.02;
  // Diagonal pairs — a trot, which is what stops a four-legged walk looking like a pantomime.
  let hipFR = 0;
  let hipFL = 0;
  let hipBR = 0;
  let hipBL = 0;
  let tail1 = TAIL_UP + Math.sin(t * 0.9) * 0.05;
  // The per-link baseline is SMALL because it accumulates: four links at 0.18 is a right angle.
  let tail2 = 0.08 + Math.sin(t * 0.9 - 0.5) * 0.07;
  let tail3 = 0.08 + Math.sin(t * 0.9 - 1.0) * 0.09;
  let tailRY = Math.sin(t * 0.7) * 0.12;

  switch (ctx.action) {
    case 'walk':
    case 'run':
    case 'swim':
    case 'fly': {
      const k = 0.5 + 0.5 * ctx.moveSpeed;
      const w = ctx.cycle(GAIT, 5.0 + 4.0 * ctx.moveSpeed);
      const a = Math.sin(w);
      const b = Math.sin(w + Math.PI);
      hipFR = a * (0.62 * k);
      hipBL = a * (0.56 * k);
      hipFL = b * (0.62 * k);
      hipBR = b * (0.56 * k);
      // `impact` SPIKES at contact rather than easing: the barrel drops onto the leg and squashes, which is the weight.
      const impact = Math.abs(Math.cos(w)) ** 12;
      bodyY = BODY_Y + Math.abs(a) * 0.022 * k - 0.02 * impact;
      sq = 1 - 0.055 * impact;
      bodyRX = 0.05 * k + Math.sin(w * 2 + 0.6) * 0.03;
      bodyRZ = a * 0.055 * k;
      headRX = HEAD_PITCH - 0.08 * k + Math.sin(w * 2 - 0.8) * 0.05;
      headRY = Math.sin(t * 0.8) * 0.07;
      headRZ = -a * 0.05;
      headY = HEAD_Y - 0.02 * impact;
      jawOpen = 0.06;
      tail1 = TAIL_UP + 0.10 * impact;
      const s = ctx.cycle(TAIL, 3.2 + 2.0 * ctx.moveSpeed);
      tailRY = Math.sin(s) * 0.22;
      tail2 = 0.08 + Math.sin(s - 0.6) * 0.10;
      tail3 = 0.08 + Math.sin(s - 1.2) * 0.13;
      break;
    }
    case 'attack': {
      const coilT = easeOutCubic(clamp01(at / 0.18));
      const lunge = easeOutCubic(clamp01((at - 0.18) / 0.14));
      const rec = easeInOutSine(clamp01((at - 0.36) / 0.36));
      const drive = lunge * (1 - rec);
      const coil = coilT * (1 - lunge);
      const snap = easeOutCubic(clamp01((at - 0.28) / 0.08));
      bodyZ = -0.10 * coil + 0.24 * drive;
      bodyY = BODY_Y - 0.05 * coil + 0.03 * drive;
      bodyRX = 0.22 * coil - 0.26 * drive;
      sq = 1 - 0.05 * coil + 0.04 * drive;
      headRX = HEAD_PITCH + 0.30 * coil - 0.34 * drive;
      headRY = 0;
      headY = HEAD_Y - 0.03 * coil + 0.05 * drive;
      jawOpen = 0.85 * Math.max(coil * 0.5, lunge) * (1 - snap); // the bite shuts
      hipFR = -0.45 * coil + 0.55 * drive;
      hipFL = -0.45 * coil + 0.55 * drive;
      hipBR = 0.40 * coil - 0.30 * drive;
      hipBL = 0.40 * coil - 0.30 * drive;
      tail1 = TAIL_UP + 0.35 * coil - 0.25 * drive;
      tailRY = Math.sin(t * 7) * 0.10;
      break;
    }
    case 'cast': {
      const rise = easeInOutSine(clamp01(at / 0.30));
      const fall = easeInOutSine(clamp01((at - 0.75) / 0.30));
      const amp = rise * (1 - fall);
      const shiver = Math.sin(t * 26) * 0.015 * amp;
      bodyRX = -0.16 * amp;
      bodyY = BODY_Y + 0.04 * amp + shiver;
      sq = 1 + 0.04 * amp;
      headRX = HEAD_PITCH - 1.05 * amp;
      headRY = 0;
      headRZ = shiver * 2;
      headY = HEAD_Y + 0.06 * amp;
      jawOpen = 0.95 * amp;
      hipFR = -0.20 * amp;
      hipFL = -0.20 * amp;
      hipBR = 0.16 * amp;
      hipBL = 0.16 * amp;
      tail1 = TAIL_UP + 0.30 * amp;
      tail2 = 0.08 + 0.20 * amp;
      tail3 = 0.08 + 0.24 * amp;
      tailRY = Math.sin(t * 3) * 0.06;
      break;
    }
    case 'special': {
      const rise = easeOutCubic(clamp01(at / 0.34));
      const fall = easeInOutSine(clamp01((at - 0.92) / 0.34));
      const amp = rise * (1 - fall);
      const tremor = Math.sin(t * 21) * 0.02 * amp;
      bodyRX = -0.52 * amp;
      bodyY = BODY_Y + 0.22 * amp + tremor;
      bodyZ = -0.06 * amp;
      sq = 1 + 0.05 * amp;
      headRX = HEAD_PITCH - 0.55 * amp;
      headRY = 0;
      headY = HEAD_Y + 0.04 * amp;
      jawOpen = 0.70 * amp;
      hipFR = -1.15 * amp;
      hipFL = -1.15 * amp + Math.sin(t * 9) * 0.12 * amp;
      hipBR = 0.30 * amp;
      hipBL = 0.30 * amp;
      tail1 = TAIL_UP + 0.45 * amp;
      tail2 = 0.08 + 0.26 * amp;
      tail3 = 0.08 + 0.30 * amp;
      tailRY = Math.sin(t * 5) * 0.14 * amp;
      break;
    }
    case 'hurt': {
      const d = Math.max(0, 1 - at / 0.5);
      bodyZ = -0.09 * d;
      bodyY = BODY_Y + Math.sin(at * 52) * 0.012 * d;
      bodyRX = 0.20 * d;
      bodyRZ = Math.sin(at * 46) * 0.10 * d;
      bodyRY = Math.sin(at * 40) * 0.09 * d;
      sq = 1 - 0.04 * d;
      headRX = HEAD_PITCH + 0.34 * d;
      headRZ = Math.sin(at * 50) * 0.14 * d;
      jawOpen = 0.40 * d + 0.05;
      hipFR = 0.30 * d;
      hipFL = 0.22 * d;
      hipBR = -0.24 * d;
      hipBL = -0.18 * d;
      tail1 = TAIL_UP - 0.30 * d;
      tailRY = Math.sin(at * 30) * 0.14 * d;
      break;
    }
    case 'happy': {
      const hop = Math.abs(Math.sin(at * 5.6));
      bodyY = BODY_Y + hop * 0.10;
      sq = 1 + Math.sin(at * 11.2) * 0.05;
      bodyRY = Math.sin(at * 2.8) * 0.30;
      bodyRZ = Math.sin(at * 5.6) * 0.06;
      headRX = HEAD_PITCH - 0.30;
      headRZ = Math.sin(at * 5.6) * 0.16;
      headRY = Math.sin(at * 2.8) * 0.22;
      headY = HEAD_Y + hop * 0.03;
      jawOpen = 0.32 + Math.sin(at * 11.2) * 0.16;
      hipFR = -0.42 * hop;
      hipFL = -0.42 * hop;
      hipBR = 0.26 * hop;
      hipBL = 0.26 * hop;
      tail1 = TAIL_UP + 0.20;
      tailRY = Math.sin(at * 10) * 0.55;
      tail2 = 0.08 + Math.sin(at * 10 - 0.6) * 0.14;
      tail3 = 0.08 + Math.sin(at * 10 - 1.2) * 0.18;
      break;
    }
    case 'idle':
    default:
      break;
  }

  const bodyG = p.body;
  bodyG.position.set(0, bodyY, bodyZ);
  bodyG.rotation.set(bodyRX, bodyRY, bodyRZ);
  // Squash is volume-preserving, but only a QUARTER goes sideways: at 0.6 the flanks swept a
  // third of a cell outward every footfall, past whatever the legs and ribs were cleared against.
  const xz = 1 + (1 - sq) * 0.25;
  bodyG.scale.set(xz, sq, xz);

  p.head.position.y = headY;
  p.head.rotation.set(headRX, headRY, headRZ);
  p.jaw.rotation.x = jawOpen;

  p.legFR.rotation.x = hipFR;
  p.legFL.rotation.x = hipFL;
  p.legBR.rotation.x = hipBR;
  p.legBL.rotation.x = hipBL;

  // Four links off three authored angles: the wave is a shape, so the tip's share is interpolated down the chain.
  p.tail1.rotation.set(tail1, tailRY, 0);
  p.tail2.rotation.set(tail2, tailRY * 0.75, 0);
  p.tail3.rotation.set(tail3, tailRY * 0.5, 0);
  p.tail4.rotation.set(tail3, tailRY * 0.3, 0);
}

export const species: BeastSpecies = {
  id: 'graveback',
  nameKey: 'beast.graveback.name',
  element: 'shadow',
  locomotion: 'ground',
  descriptionKey: 'beast.graveback.desc',
  // A wall: hits hard, hard to move, slow enough that the player has to want the trade. The Graveborn is the fast half.
  baseStats: { maxHp: 68, attack: 15, defense: 17, speed: 4.4 },
  skills: [
    'graveback.bonecrush',
    'graveback.grave-howl',
    'graveback.rib-shard',
    'graveback.barrow-tide',
  ],
  buildRig,
  animate,
};
