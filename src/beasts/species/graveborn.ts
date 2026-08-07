import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Graveborn — issue #119. The roster's first BIPED: a bleached skeleton
// soldier in salvaged leather with a chipped iron sword, grave-light burning in
// its sockets. Every other species is an animal on four legs (or wings, or
// fins), so nothing here reuses an existing gait — the walk is a human walk
// with counter-swinging arms, and the sword hand carries the whole read of the
// silhouette from behind.
//
// Voxel scale 0.06 — smaller than the roster's usual 0.1, because a ribcage is
// a LATTICE and at 0.1 a rib is one fat cell with a gap beside it as wide as
// itself, so the torso photographs as a striped barrel rather than as bone with
// light coming through it. It was 0.045 for two capture rounds, on the same
// reasoning pushed further, and that was the wrong direction: at 0.045 a limb
// bone is either one cell (45 mm, invisible at play distance) or three (a plank
// of bone), and the face carried enough cells to hold four tones, which came
// back as a chequer. 0.06 is the density the reference sheet itself is drawn
// at — about twenty-eight cells from sole to crown — and every part below is
// sized in the reference's own cell counts rather than in millimetres.
//
// Model faces +Z. Root origin at ground level, ~1.84 units to the crown.
// ---------------------------------------------------------------------------

const S = 0.06;

// Palette. Bone is a WARM off-white, never a grey: under this game's warm sun
// (0xfff2d9) a neutral bone reads as dirty plastic, and next to the fox's orange
// and the pup's basalt a cool skeleton looks like it came from another game.
// The three bone values are a full stop apart so a rib in front of the spine is
// separable from the spine behind it — which, on a lattice, is the entire job.
const C = {
  // Dropped a full stop from 0xd6c9a2. That value sat inside the same band as
  // this game's sunlit dirt road and its lit grass, so at twenty metres the
  // whole figure dissolved into the ground it was standing on and only the eyes
  // survived. Bone has to be lighter than the terrain, not the same as it, and
  // the reading is done by boneLt on the crown, sternum and clavicle.
  bone: 0xc4b48c,        // sun-bleached bone, the body value
  boneLt: 0xf2e8c6,      // crowns, sternum, forward edges — the lit rim
  // The shadow tones stay on the WARM side of neutral. At 0xa2946c / 0x776a4c
  // they were a shade green, and this game's fill is a cool sky hemisphere:
  // the shaded half of the skull photographed olive, which turned the face into
  // a half-mask and dropped the socket to the same value as the bone around it.
  // Bone in shadow has to still read as bone, not as stone.
  // Warm, but still a STOP apart from the body tone. They were taken to
  // 0xb8a476 / 0x8f7a50 to kill a green cast, which worked and cost the
  // separation: under 10% luminance from `bone`, the far arc of a rib stopped
  // separating from the near arc and the chest photographed as chainmail.
  boneDk: 0xa89468,      // undersides, the back half of every rib
  boneDp: 0x84703f,      // joint shadow and the mouth line: the deepest bone
  socket: 0x241f18,      // eye socket and nasal void — a very dark BROWN, not
  // black: pure black punches a hole in the silhouette (see eyes2x2's note), and
  // on a head this pale a hole is all anyone sees.
  eye: 0x2ec6ee,         // grave-light. Emissive, and low — see the eyes2x2 call.
  // Catchlight, and it is a MID cyan rather than the near-white the house eye
  // usually takes. On a fur face the catchlight is one cell inside a dark iris;
  // here the iris is itself emissive, so a near-white cell on top of it blew
  // the pair into two white slabs with no colour left in them.
  eyeLt: 0x8fdcf2,       // catchlight inside the glow
  // Leather, and it is deliberately DESATURATED. The first pass used a
  // 0x7a4a2a / 0x9d6238 pair, which is the right hue on paper and photographed
  // as bright rust: against the warm sun and the warm bone it read as orange
  // plastic and the belt, both pauldrons and all four leg wraps became the
  // loudest thing on the model. Pulled toward grey-brown, the straps sit BEHIND
  // the bone the way worn tack does.
  leather: 0x6d4a30,     // salvaged strapping: belt, pauldrons, bracers, wraps
  leatherLt: 0x8a5f3c,   // sunlit top edge of every strap
  // Not 0x3e2819. Under ACES and this game's 4.9:1 sun-to-fill ratio anything
  // below about 0x48 crushes, and the pauldrons came back as two black blobs
  // with a blue rivet in them rather than as leather in shadow.
  leatherDk: 0x6a4a2c,   // under a strap, and the ragged hem of the skirt
  // Grave-iron, and it is deliberately DESATURATED toward warm grey rather than
  // the blue-grey steel the hero's kit uses. At 0x9aa6b2 / 0x67717c every face
  // turning away from the sun photographed navy, and the sword became the
  // largest blue object on a character whose one accent colour is the cyan in
  // its sockets. Cyan belongs to the grave-light alone.
  steel: 0xb0a89c,       // buckle, rivets, blade
  steelLt: 0xe4dfd4,     // the blade's lit edge column
  steelDk: 0x7a7064,     // blade spine and crossguard shadow
} as const;

/** Emissive intensity on the iris. Kept low on purpose — a bloom pass is
 *  downstream of this and a blown iris is a pair of headlamps, which is exactly
 *  the note eyes2x2 carries about `glow`. 0.8 blew out under bloom and left two
 *  cyan slabs with no socket around them; 0.45 still carries at dusk. */
const EYE_GLOW = 0.45;

// Base pose constants — shared between buildRig() and animate(), because a
// number that appears in both is a pose that drifts the day one of them moves.
// The skeleton stands ~1.84 to the crown, and the LEG is 36% of that. It was
// 32% for the first capture, which is a child's proportion — beside a sword it
// read as a squat imp rather than as a soldier. The gain is bought by making
// the SHIN long rather than by raising the hip: the reference sheet's whole
// lower-leg read is a long pale bone with a band at each end of it.
const HIP_Y = 0.66;        // hip joints, above the root
// 0.88 against a belt whose top lands at 0.86: the lowest rib ring and the top
// of the belt were sharing a plane where they overlapped, and the two cells of
// daylight between them are what part it. It is also the lumbar gap, which the
// reference sheet shows as a real gap with spine visible through it.
const TORSO_Y = 0.88;      // lumbar pivot: the ribcage twists here
const PELVIS_Y = 0.62;
const SHOULDER_Y = 0.44;   // within the torso group — level with the clavicle
// 0.27 — level with the tip of the clavicle bar, which is where a shoulder is.
// It was 0.21 for two capture rounds, half a cell outboard of the ribs, and the
// arm was invisible in every one of them: a one-cell bone has no chance against
// a body it is buried in, whatever it is painted. Then 0.30, which fixed that
// and bought a superhero: eleven-cell shoulders over a five-cell pelvis. The
// pelvis widened at the same time this came in, so the ratio is a soldier's.
const SHOULDER_X = 0.27;
const NECK_Y = 0.56;       // within the torso group
const KNEE_Y = -0.24;      // within the hip group
const ELBOW_Y = -0.24;     // within the shoulder group

/**
 * THREE TENTHS OF A VOXEL, and it is the whole reason this rig is seam-free.
 *
 * A limb is the one place two parts run PARALLEL rather than meeting end-on:
 * a femur and a tibia of the same width, with the knee straight, present their
 * outer walls on one plane for the length of the overlap, and test-zfight
 * reports the pair at every pose in the sweep where the knee is near straight —
 * which is most of a walk. The alternatives are to make the two bones different
 * widths (which distorts anatomy to satisfy a tool) or to leave clear air at
 * the joint (which the pose sweep closes again the moment the hip swings).
 *
 * Offsetting the joint itself is the fix AGENTS.md names — part the grid at the
 * joint — and it is applied here at EVERY joint whose two sides can end up
 * side-on to each other: both hips, both knees, both shoulders, both elbows,
 * the neck, the jaw, the pelvis and the sword hand. Each is displaced along one
 * or two axes by a fraction of a cell, so no wall on the far side of a joint
 * can land on a wall on the near side. The DIRECTION of each is free and was
 * settled by measurement — several of them were signed the other way first, and
 * a parting that cancels its parent's simply moves the pair one link along.
 *
 * 0.3 of a cell, and NOT a half. A half was the first attempt and it does not
 * hold: `build(center = true)` re-bases each mesh on its own bounding box, so a
 * part whose cell span is even already carries a half-cell shift of its own,
 * and a half-cell parting cancels it exactly — which is how the jaw, parted
 * half a cell from the torso through the neck, still landed flush on the
 * pauldron. Three tenths cannot be cancelled by any combination of whole and
 * half cells, which is the whole property being bought.
 *
 * On screen it is 18 mm on a figure 1.84 tall: the knee and the elbow read as
 * very slightly outboard of the bone above them, which is what a joint does.
 */
const JOINT_PART = S * 0.3;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'graveborn.rusted-cleave',
    nameKey: 'skill.graveborn.rusted-cleave.name',
    descriptionKey: 'skill.graveborn.rusted-cleave.desc',
    element: 'shadow',
    targeting: 'melee',
    cost: 5,
    cooldown: 1.4,
    power: 15,
    range: 2.8,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'graveborn.bone-shard',
    nameKey: 'skill.graveborn.bone-shard.name',
    descriptionKey: 'skill.graveborn.bone-shard.desc',
    element: 'shadow',
    targeting: 'projectile',
    cost: 13,
    cooldown: 5.5,
    power: 24,
    range: 16,
    learnAtLevel: 5,
    castAnim: 'cast',
  },
  {
    id: 'graveborn.grave-ward',
    nameKey: 'skill.graveborn.grave-ward.name',
    descriptionKey: 'skill.graveborn.grave-ward.desc',
    element: 'shadow',
    targeting: 'aoe',
    cost: 17,
    cooldown: 8,
    power: 28,
    range: 5,
    storePrice: 250,
    castAnim: 'special',
  },
  {
    id: 'graveborn.last-rites',
    nameKey: 'skill.graveborn.last-rites.name',
    descriptionKey: 'skill.graveborn.last-rites.desc',
    element: 'shadow',
    targeting: 'beam',
    cost: 25,
    cooldown: 12,
    power: 46,
    range: 13,
    storePrice: 400,
    castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Voxel parts
//
// EVERY PART'S CELL SPAN IS SYMMETRIC IN X, and that is a rule rather than a
// habit. `build(center = true)` re-bases a mesh on its own bounding box, so a
// part whose x span is symmetric lands exactly on its group's origin and a part
// whose span is lopsided lands half a cell off it. The pauldron's rivet was
// painted at `dir * 2` outside a pauldron that only reached |x| = 1, which made
// the right arm's bounding box -1..2 and the left arm's -2..1 — two different
// centres, and the rig dump showed the left pauldron reaching a third further
// from the spine than the right one. Keep every span symmetric and the pair
// cannot drift.
// ---------------------------------------------------------------------------

/**
 * One rib: the SHELL of an ellipse in the x/z plane at height `y`.
 *
 * Written as a shell test rather than as a hand-listed staircase because a
 * hand-listed arc has to be re-listed for every radius, and the rings here are
 * two different radii. The test — "inside the ellipse, and at least one
 * four-neighbour outside it" — produces a face-connected ring by construction,
 * which matters: a ring joined only at its diagonals photographs as a dotted
 * line of loose cubes, the same failure the drakelet's wing ribs had.
 *
 * The back half is painted a stop down. A rib is a loop and the camera sees
 * both halves of it through the gaps in the cage; with one value the far arc
 * and the near arc merge into a solid band and the cage stops being a cage.
 */
function ribRing(v: VoxelModel, y: number, w: number, d: number): void {
  const inside = (x: number, z: number): boolean => (x / w) ** 2 + (z / d) ** 2 <= 1;
  for (let x = -w; x <= w; x++) {
    for (let z = -d; z <= d; z++) {
      if (!inside(x, z)) continue;
      const shell = !inside(x + 1, z) || !inside(x - 1, z)
        || !inside(x, z + 1) || !inside(x, z - 1);
      if (!shell) continue;
      // The two cells nearest the sternum drop a row, so each rib reaches the
      // breastbone as a shallow CHEVRON rather than as a straight bar. A ring
      // painted at one constant y photographs from the front as four horizontal
      // rails across a bright vertical column — a radiator, not a ribcage — and
      // that downward angle into the sternum is the whole visual signature of
      // the real thing.
      // ONE row, over the three cells nearest the sternum. Two rows was tried
      // and it is arithmetically wrong on a cage whose rings are two rows
      // apart: the dropped centre of one ring lands exactly on the ring below
      // it, so the daylight the gap was for gets filled in and the chest
      // photographs as a field of same-size chips. One row angles the rib into
      // the breastbone and leaves the gap open, which is the whole point of it.
      const drop = z === d && Math.abs(x) <= 1 ? 1 : 0;
      // The back arc goes to the DEEPEST bone tone. At boneDk it was within a
      // stop of the front arc, and seen through the gaps the two halves of each
      // loop merged into one solid band — which is a barrel, not a cage.
      v.set(x, y - drop, z, z >= d ? C.boneLt : z < 0 ? C.boneDp : C.bone);
    }
  }
}

/**
 * A closed band of leather — a belt, a bracer, an ankle wrap. Lit on top.
 *
 * A band is a RING with nothing in the middle of it, so whatever it is strapped
 * around has to actually be there: a bracer painted at the height of a gap in
 * the bone below it is eight cells joined to the rest of the model only at
 * their diagonals, and `build()` will happily bake it as a floating brown hoop.
 * That shipped for one capture round and a critic reading the attack pose
 * logged "two detached voxels floating in mid-air between the feet" — it was
 * the knee band, hanging off the top of a tibia that stopped a row short of it.
 * Every caller here runs the bone THROUGH the band's rows.
 */
function strap(v: VoxelModel, y: number, w: number, d: number, rows = 2): void {
  for (let r = 0; r < rows; r++) {
    for (let x = -w; x <= w; x++) {
      for (let z = -d; z <= d; z++) {
        if (Math.abs(x) < w && Math.abs(z) < d) continue; // a band, not a block
        v.set(x, y + r, z, r === rows - 1 ? C.leatherLt : C.leather);
      }
    }
  }
}

/**
 * The skull: a tapered block with a pale face plate, two burning sockets, a
 * nasal void and a line of teeth standing proud of a dark mouth.
 *
 * Seven cells wide so the cell grid is symmetric about x = 0 — `eyes2x2`
 * mirrors the caller's right-hand geometry and cannot do that on an even width.
 *
 * THREE TONES ON THE FACE, and that is the hard-won part. Earlier passes
 * carried a lit zygomatic cell, a shaded one under it, a half-value bone lid
 * over each eye and teeth drawn as alternating light and dark cells. Every one
 * of those is defensible alone; together, inside a seven-cell face, the capture
 * came back as a light/dark chequer that read as a corrupted texture. Pale
 * bone, black holes, and one line of teeth is the whole of it.
 *
 * The SILHOUETTE carries the rest. A skull painted as a plain box reads as a
 * villager's head with two lit windows in it however good the face plate is —
 * so the crown steps in a cell all round, the maxilla is narrower and shallower
 * than the cranium above it, and the teeth stand a cell proud of a recessed
 * mouth. Those three steps are what make the outline a skull before any of the
 * paint is visible.
 */
function buildSkull(): THREE.Mesh {
  const v = new VoxelModel();
  for (let y = 1; y <= 6; y++) {
    const inset = y === 6 ? 1 : 0; // stepped crown
    v.box(-3 + inset, y, -3 + inset, 3 - inset, y, 3 - inset, C.bone);
  }
  v.box(-2, 0, -2, 2, 0, 3, C.bone); // maxilla, narrower and shallower
  // Crown and underside only. Handed the skull's whole y range these two walk
  // down each column and repaint whichever cell they hit first — which, on a
  // box, is a FRONT-face cell as often as a top one, and that was half the
  // chequer above. One row each is what they are for.
  rimTop(v, C.boneLt, -3, 3, 6, 6, -3, 3);
  shadeUnder(v, C.boneDk, -3, 3, 0, 0, -3, 3);

  // -- the face, on the z = 3 plane. Socket recess FIRST: a solid dark
  // rectangle two cells wide and three tall per side, which the grave-light
  // then fills the middle of, leaving a dark cell on every side of each iris.
  // eyes2x2's own `lid` is a half-value COAT row, right for a furred muzzle and
  // wrong on a skull, so it is handed the socket tone instead and keeps the row
  // above each iris part of the hole.
  // The socket is THREE cells wide and three tall per side, and the light
  // inside it is ONE cell wide. That ratio is the whole read. A 2x2 iris in a
  // 2x2 socket leaves no dark anywhere around the glow, so the "recess" exists
  // only in the source: two capture rounds came back with cyan letterboxes
  // glued to a beige box, which is a face in ski goggles and not a skull. What
  // makes a socket a hole is the black around the light, not the light.
  // A PORTRAIT orbit: two cells wide and three tall of true socket, with a
  // shaded cheek beyond it rather than more hole. Three wide by two tall was a
  // landscape slot under a full-width brow, which at twenty metres is a visor;
  // three wide by three tall was a mask. Two by three is an eye socket, and the
  // shaded outer column keeps the head from ending abruptly beside it.
  for (const sx of [1, -1]) {
    for (let y = 3; y <= 5; y++) {
      v.set(sx * 2, y, 3, C.socket);
      v.set(sx * 3, y, 3, C.socket);
    }
  }
  // `inner: 2, width: 1` puts a single glowing column at |x| = 2 with a dark
  // cell on both sides of it and dark above and below. No `bridge`: the macro's
  // bridge fills the WHOLE gap between the eyes, which at this spacing would
  // paint over the dark cell inboard of each socket — the ridge is painted by
  // hand below instead, one cell wide.
  eyes2x2(v, {
    inner: 2, width: 1, y: 4, faceZ: 3,
    iris: C.eye, glow: EYE_GLOW, shine: C.eyeLt,
  });
  // THREE CELLS of lit bone between the sockets, not one. One cell is 60 mm on
  // a figure 1.84 tall — under a pixel at fifteen metres — so the two holes
  // bridged into a single dark band across the eye line and the head read as a
  // visor with a light at each end. This is where the eye lands on the whole
  // model, so it is the one place a sub-pixel detail cannot be left standing.
  // Only the centre column stands proud: a three-cell ledge is a nose.
  for (let y = 3; y <= 5; y++) v.box(-1, y, 3, 1, y, 3, C.boneLt);
  v.set(0, 4, 4, C.boneLt);
  v.set(0, 5, 4, C.boneLt);
  // Brow: a shaded row across the whole face, standing a cell PROUD, so both
  // sockets sit under a real shelf and throw their own shadow. This is what
  // makes an eye socket a hole in a head rather than a sticker on a box, and it
  // is the one thing that still reads at twenty metres.
  for (let x = -2; x <= 2; x++) {
    v.set(x, 6, 3, C.boneDk);
    v.set(x, 6, 4, C.boneDk);
  }
  // Nasal aperture: an inverted triangle, not a single cell. One cell was lost
  // in three unbroken rows of flat bone between the sockets and the teeth —
  // the largest featureless plane on the character, which read as a muzzle.
  v.set(0, 2, 3, C.socket);
  v.set(0, 1, 3, C.socket);
  v.set(-1, 1, 3, C.socket);
  v.set(1, 1, 3, C.socket);
  // Zygomatic: one shaded cell at each cheekbone, which is the rest of what
  // breaks that plane up.
  v.set(-3, 2, 3, C.boneDk);
  v.set(3, 2, 3, C.boneDk);
  // The mouth is a two-row DARK BAND with the teeth painted into it as
  // alternating proud cells. Flush pale teeth on a pale face were invisible at
  // every distance tested, in both directions — dark-on-pale and pale-on-dark —
  // because there was no gap behind them. Cut the gap first, then hang the
  // teeth in it, and the alternation reads as teeth instead of as a chequer
  // because the cells it alternates with are a hole rather than more bone.
  for (let x = -2; x <= 2; x++) {
    v.set(x, 0, 3, C.socket);
    if (x % 2 === 0) v.set(x, 0, 4, C.boneLt);
  }
  return v.build(S, true);
}

/**
 * The mandible, on its own hinge so the jaw can drop for a roar.
 *
 * ONE ROW, and the height is load-bearing twice over. Visually, the upper jaw
 * is already a row of the skull, so two rows here made the lower face half the
 * head and the mouth a dark bar slung under it. Structurally, the jaw hangs two
 * rows below the skull's own base and the clavicle bar is right there: at two
 * rows the mandible's underside landed flush on the collarbone's, which is a
 * coplanar pair test-zfight reports every time the jaw swings.
 */
function buildJaw(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-2, 0, -2, 2, 0, 3, C.bone);
  // The mouth line, on the FRONT face only — under the maxilla's proud teeth.
  for (let x = -2; x <= 2; x++) v.set(x, 0, 3, C.boneDp);
  return v.build(S, true);
}

/**
 * Spine, ribcage, clavicle and neck as one mesh.
 *
 * One mesh and not four because none of them move relative to each other — the
 * torso group is the only pivot here — and four meshes would be four draw calls
 * per Graveborn for a shape that never separates.
 *
 * THE CLAVICLE IS THE WIDEST THING ON THE BODY, at eleven cells against the
 * cage's seven and the skull's seven. It was seven for two capture rounds, so
 * skull, chest and shoulders were all the same width and the figure read as a
 * column with a box on top — and worse, it left the arms hanging half a cell
 * outboard of the ribs, where a bone the width of a rib is simply invisible.
 * The widening is what gives the silhouette a shoulder to hang an arm off.
 */
function buildRibcage(): THREE.Mesh {
  const v = new VoxelModel();
  for (let y = 0; y <= 6; y++) v.set(0, y, -2, C.boneDk); // spine, up the back

  // -- four rib pairs, two rows apart so light comes through between them, and
  // the lowest one short: a cage that does not taper into the waist is a barrel.
  ribRing(v, 6, 3, 2);
  ribRing(v, 4, 3, 2);
  ribRing(v, 2, 3, 2);
  ribRing(v, 0, 2, 2);

  // -- sternum: the column joining the rings' front ends. Without it the arcs
  // float apart at the front and the chest is a set of loose hoops.
  // Stops at row 1, not row 0. The bottom ring is narrower and its chevron
  // drops away from the sternum, so a sternum cell at row 0 was left joined to
  // nothing the eye could follow — a loose pale chip floating in the lumbar gap.
  for (let y = 1; y <= 6; y++) v.set(0, y, 2, C.boneLt);

  // -- clavicle bar, the acromion knobs the pauldrons hang off, and a scapula
  // plate behind it — what the rear view has instead of a chest.
  v.box(-4, 7, 1, 4, 7, 1, C.bone);   // one cell deep — two rows read as a yoke
  v.box(-1, 7, 0, 1, 7, 0, C.boneLt); // manubrium, where the two bones meet
  v.set(4, 7, 1, C.boneLt);           // acromion, where the pauldron sits
  v.set(-4, 7, 1, C.boneLt);
  v.set(3, 7, 1, C.boneDk);           // a shaded cell inboard of each tip, so
  v.set(-3, 7, 1, C.boneDk);          // the bar reads as two bones, not one
  v.box(-3, 7, -2, 3, 7, -2, C.boneDk);

  // -- TWO cervical vertebrae, and the second one is not decoration. Dropping
  // the cage a row and widening the clavicle opened a gap between the mandible
  // and the collarbone that the capture read as a head posted on nothing — the
  // classic voxel-rig bug. The column has to be continuous from the clavicle to
  // the jaw hinge at every head pitch in the pose sweep.
  // THREE cells wide, not one. Two vertebrae stacked one cell across is a
  // stick, and a head on a stick is the read the capture came back with; the
  // reference sheet's neck is a short solid column you can barely see.
  for (let y = 8; y <= 9; y++) {
    v.box(-1, y, 0, 1, y, 0, C.bone);
    v.box(-1, y, -1, 1, y, -1, C.boneDk);
  }
  return v.build(S, true);
}

/** The lowest cell `buildPelvis` paints — the longest tongue of the skirt. */
const HEM = -7;

/**
 * Pelvis, belt, buckle and the tattered skirt, as ONE voxel grid.
 *
 * The skirt was its own mesh for one round and it cost two seams, because the
 * only place a skirt can hang is exactly where the pelvis already is: whatever
 * radius the wrap took, some wall of it landed on a wall of the belt or of the
 * ilium and test-zfight reported the pair. Nothing here ever moves relative to
 * anything else here — one group carries the lot — so painting them into one
 * grid is not a workaround, it is the correct shape: `build()` drops every face
 * between two touching cells, so a coplanar pair becomes impossible rather than
 * merely unlikely. It is also one draw call instead of two.
 *
 * The skirt is FRONT AND BACK PANELS ONLY, which is what the reference sheet
 * shows and is also the only version that works: a closed cone hides the
 * femurs, and the femurs are the reason a skeleton's legs read as a skeleton's
 * legs. The hem is a deep V — one cell at the flanks against six in the middle.
 * A near-square panel was the first attempt and at play distance it had no
 * raggedness left in it at all: the whole pelvis read as a pair of brown shorts.
 */
function buildPelvis(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-3, 0, -1, 3, 1, 1, C.bone); // ilium and the hip sockets under it
  v.set(3, 0, 0, C.boneDp);
  v.set(-3, 0, 0, C.boneDp);
  rimTop(v, C.boneLt, -3, 3, 1, 1, -1, 1);

  // Panels, hung at the BELT's own depth so each visibly continues the belt
  // down rather than starting from thin air an inch inboard of it. Each entry
  // is how far that column falls from row 1.
  // Seven columns now that the belt is seven wide, and the centre falls FOUR
  // rows rather than six: a longer tongue hangs between the femurs and hides
  // them, and bare femur either side of the tabard is exactly what the
  // reference sheet shows.
  // Longer, and ASYMMETRIC left to right. A hem that falls the same on both
  // sides of centre reads as a scallop however ragged the profile is; the tear
  // has to be lopsided to read as a tear. The centre reaches mid-thigh, which
  // is where the reference sheet's tabard ends — long enough to be a garment,
  // short enough that bare femur still shows either side of it.
  // FIVE columns, not seven. At seven the panel spanned the whole pelvis and
  // covered the inboard half of both femurs, so the belt-to-thigh region was
  // one solid brown mass and the bare bone the tabard is supposed to hang
  // between never showed. Five leaves a clear cell of femur outboard of it.
  //
  // The NOTCH is the point of the numbers themselves. A monotonic staircase
  // down to a centre column is a hem cut with shears however asymmetric it is;
  // a column that jumps back UP mid-fall is a hem that was torn, and the step
  // has to be two rows or more to survive being looked at from ten metres.
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

  // The belt over the top of them, the same width as the hips. Seven cells: at
  // five, the figure was eleven-cell shoulders over a five-cell pelvis, which
  // is a superhero build and not the reference's soldier.
  strap(v, 2, 3, 2);
  // Buckle: a steel frame with a dark tongue in the middle of it, spanning both
  // belt rows on the front face only.
  // A square frame with the belt showing through it, fitted INSIDE the belt's
  // own two rows. It overhung them by a row for one capture and the grey stood
  // proud of the brown above and below, which reads as a broken part; painted
  // in the lit steel it was also the highest-contrast object on the whole
  // character and the eye landed on the hip instead of on the skull. One cell
  // of steelLt, for the tongue, is all the brightness a buckle needs.
  for (const y of [2, 3]) {
    v.set(-1, y, 3, C.steel);
    v.set(1, y, 3, C.steel);
  }
  v.set(0, 3, 3, C.steel);
  v.set(0, 2, 3, C.steelLt);  // the tongue, catching the light
  for (const x of [-1, 1]) v.set(x, 3, -2, C.steel); // rivets, read from behind

  const m = v.build(S, true);
  // build() zeroes y on the LOWEST cell, which is the hem — so the offset that
  // puts grid row 0 (the base of the pelvis) back on the group origin is the
  // hem's own depth. Derived, not measured: lengthen a panel and this follows.
  m.position.y = HEM * S;
  return m;
}

/**
 * The femur: hip to knee, two cells square.
 *
 * One cell was the reference sheet's literal proportion and it was the wrong
 * measurement to copy. That sheet is a portrait on an empty background, where a
 * single dark-edged cell reads perfectly well; this model stands in a voxel
 * world of chunky trees and grass at twenty metres, and a 6 cm bone against
 * that is a thread. The reference's FIGURE is heavy-set — the impression to
 * match is a soldier, not the cell count that produced it on a grey card.
 */
function buildThigh(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(0, 0, 0, 1, 3, 1, C.bone);
  v.box(0, 3, 0, 1, 3, 0, C.boneLt); // femoral head, catching the light
  v.box(0, 0, 1, 1, 0, 1, C.boneDk); // knee end, in its own shadow
  const m = v.build(S, true);
  m.position.y = -4 * S;
  return m;
}

/** Shin, ankle and foot, with one leather band at each end of the bone. */
function buildShin(): THREE.Mesh {
  const v = new VoxelModel();
  // The tibia runs THROUGH both bands' rows — see the note on strap(). It used
  // to stop at row 5 with the knee band at row 6, which left the band joined to
  // the leg only at its diagonals: a floating brown hoop.
  v.box(0, 1, 0, 1, 6, 1, C.bone);
  v.box(0, 6, 0, 1, 6, 0, C.boneLt);
  // Foot: heel behind, toes forward with a raised cap, so the front view has a
  // step in it rather than a flat pale pad.
  v.box(-1, 0, -1, 2, 0, 2, C.bone);
  v.box(-1, 1, 2, 2, 1, 2, C.bone);  // toe cap, standing a row proud
  v.set(0, 1, 2, C.boneDp);          // the split between the two toe blocks
  v.set(0, 0, 2, C.boneDp);
  v.box(-1, 0, -1, 2, 0, -1, C.boneDk); // heel, in shadow
  strap(v, 1, 1, 1, 1); // ankle band, sitting straight on the foot
  strap(v, 6, 1, 1, 1); // knee band, capping the top of the bone
  const m = v.build(S, true);
  m.position.y = -7 * S;
  return m;
}

/**
 * Upper arm: humerus with the leather pauldron capping the shoulder.
 *
 * `dir` is +1 for the right side, and only the rivet uses it — it sits on the
 * OUTBOARD face of each pauldron, and mirrored geometry would put both of them
 * on the same side of the body. The rivet stays INSIDE the pauldron's own
 * three-cell span so the mesh's bounding box is symmetric either way; see the
 * note at the top of this section for what a lopsided span costs.
 */
function buildUpperArm(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  // TWO cells wide, biased outboard so the bone runs under the outer half of
  // the pauldron. One cell was the reference sheet's own proportion and it
  // failed here for a reason the reference does not have to face: this arm ends
  // in a three-cell fist, and a one-cell wire with a three-cell brick on the
  // end reads as a detached boxing glove, which is exactly what the capture
  // showed. The mass has to grow continuously — 2, then 2, then 3.
  const x0 = dir > 0 ? 0 : -1;
  // C.bone, NOT C.boneLt. Painted in the highlight tone the whole arm became
  // the brightest object on the model — brighter than the sternum, the skull
  // and the ribs — so the eye went to the outside of the figure and the chest
  // and face fell away. boneLt is the crown, the sternum and the clavicle.
  // Runs a row PAST the elbow pivot (row -1), so the humerus and the forearm
  // overlap through the whole swing instead of meeting end to end: at every
  // bend the capture showed daylight between the two boxes and the arm read as
  // two segments floating in line. JOINT_PART keeps them off each other's
  // planes whatever the overlap.
  v.box(x0, -1, 0, x0 + 1, 3, 1, C.bone);
  v.box(x0, 3, 0, x0 + 1, 3, 0, C.boneLt);
  // Pauldron: a leather cap over the top of the shoulder, wider than the joint
  // so it reads as armour sitting ON the bone rather than as a swollen elbow.
  // FIVE cells across and three rows tall. At three across it was the same
  // width and thickness as the bracer below it and as the rib bars behind it,
  // and the upper body photographed as a figure bandaged in identical brown
  // strips. On the reference sheet the pauldron is the largest single object
  // above the belt and it is what draws the shoulder line of the silhouette.
  // Five WIDE, but only two rows tall and three deep. Widening it in all three
  // axes at once turned each pauldron into a brown slab bigger than the skull,
  // and the figure grew a pair of shelves; the reference's cap is broad across
  // the shoulder and thin through it. Width is what draws the shoulder line —
  // depth and height only add mass where none is wanted.
  // STEPPED, not a slab: five cells across at the bottom row and three at the
  // top. Squared off it read as a flat epaulette sticking out sideways — a
  // plank on each shoulder — because the shoulder's own splay tilts it and a
  // box has nothing but its silhouette to say which way is up. One step turns
  // it into a cap sitting over the joint, which is what the reference has.
  v.box(-2, 2, -1, 2, 2, 1, C.leather);
  v.box(-1, 3, -1, 1, 3, 1, C.leatherLt);
  shadeUnder(v, C.leatherDk, -2, 2, 2, 2, -1, 1);
  // A riveted STEEL plate down the outboard face — a hard-edged non-bone shape
  // at the point of the shoulder, which is the reference's read. It replaces a
  // single steel cell that could only ever be one saturated pixel of noise.
  // On the FORWARD face, not the outboard one. Hung on the side of the cap it
  // was a grey sliver on the far edge that read as a lighting artefact; on the
  // front it is a rectangle the play camera actually sees, which is what the
  // reference has.
  for (const x of [dir, dir * 2]) v.set(x, 2, 1, C.steel);
  v.set(dir * 2, 3, 1, C.steel);
  v.set(dir, 3, 1, C.steelDk); // the rivet in it
  const m = v.build(S, true);
  // -3, so the pauldron's top row lands ON the pivot rather than a cell above
  // it. A cell higher and the armour stands level with the jaw, which is where
  // one capture put it; the reference sheet's pauldrons sit clearly under the
  // skull, and that one row is the difference between a soldier and a figure
  // with its head sunk into its shoulders.
  m.position.y = -3 * S;
  return m;
}

/** Forearm, leather bracer and the hand. */
function buildForearm(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  // Radius and ulna, two cells wide and biased outboard to match the humerus
  // above — see buildUpperArm. Bone runs through row 3 so the bracer has
  // something to be strapped around; at rows 4-5 only it was a floating hoop.
  const x0 = dir > 0 ? 0 : -1;
  v.box(x0, 4, 0, x0 + 1, 6, 1, C.bone);
  strap(v, 5, 1, 1, 1); // bracer, a row up: a fist touching a strap is a strap
  // The FIST, and it is deliberately big: three wide, three tall and two deep,
  // with three parted fingers curled under it and a thumb on the inboard face.
  // A two-row palm with a single row of fingers was 18 cm of hand on a figure
  // 1.84 tall and it vanished — the capture showed an arm that simply stopped
  // in a brown band, and a sword hovering beside it with nothing holding it.
  // After the pauldron this is the arm's biggest landmark, and it is the thing
  // that says where the sword is gripped.
  v.box(-1, 1, 0, 1, 3, 1, C.bone);
  rimTop(v, C.boneLt, -1, 1, 3, 3, 0, 1);
  for (const x of [-1, 0, 1]) {
    v.set(x, 0, 1, C.boneDp); // fingers: the darkest thing on the arm, or there
    // is no hand — at boneDk they were the same value as the bone above them
    v.set(x, 2, 2, x === 0 ? C.boneDp : C.bone); // knuckles, parted
  }
  v.set(-dir, 2, 0, C.boneDp); // thumb, inboard
  const m = v.build(S, true);
  m.position.y = -7 * S;
  return m;
}

/**
 * The sword.
 *
 * Built here rather than borrowed from `player/weapons.ts`, and it is worth
 * saying why since the reuse would be tempting: that module's blades are the
 * HERO's kit — gold-hilted, unblemished, and fitted by a per-weapon `FIT` table
 * to the hero's hand at his own voxel scale. This one is grave-iron with a
 * notched edge and a bare leather grip, at a different scale, and its colours
 * belong to this species the same way its bones do (see the note on
 * ALL_SPECIES in combat/enemies.ts). Importing player/ from beasts/ to get a
 * differently coloured, differently sized, differently shaped sword buys
 * nothing.
 *
 * Grip at the origin, blade running up +Y — the same convention weapons.ts
 * uses, so anything that ever wants to hold one of these knows where it is.
 * The LENGTH is set by where the point has to end up. Hanging from a fist at
 * 0.72, a blade that reaches the sole reads as a crutch — the character has
 * three legs, one of them grey — so it stops at mid-shin. Two captures put the
 * tip at or below the foot before this was cut back.
 *
 * The WIDTH matters as much. A three-cell blade under a five-cell crossguard is
 * a fence post with a bar across it; the reference sheet's blade is the widest
 * piece of metal on the model and tapers in two steps to a clipped point.
 */
function buildSword(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-1, -2, 0, 1, -2, 1, C.steelDk); // pommel slab
  v.box(0, -1, 0, 0, 0, 1, C.leatherDk); // wrapped grip
  v.set(0, 0, 1, C.leather);             // one lit turn of the wrap
  // Seven cells of crossguard. At five it was inside the forearm's own
  // silhouette from the play camera and nobody could see there was a guard at
  // all, which is most of why the weapon read as a paddle: a sword is a blade
  // AND a bar across it, and if the bar never clears the arm it is a plank.
  v.box(-3, 1, 0, 3, 1, 1, C.steel);
  v.set(-3, 2, 0, C.steelDk);
  v.set(3, 2, 0, C.steelDk);
  // Blade: three cells wide, with a bright fuller down the middle and a spine
  // one cell deeper, so at least one lit face is turned toward the camera at
  // any bearing — the plank problem the hero's weapons carry the long note
  // about. It was FIVE for one round: 0.30 across against a torso 0.42 across,
  // which hung beside the right leg and covered the whole of it, and the walk
  // photographed as a skeleton carrying a grey door. The reference sheet's
  // blade is a little under half the torso's width, which is three cells.
  for (let y = 2; y <= 9; y++) {
    const h = y <= 8 ? 1 : 0; // last two rows narrow to the point
    // The lit column is the OUTBOARD EDGE, not the centre line. Down the middle
    // it reads as a stripe painted on a rectangle; on the edge it reads as the
    // light catching a bevel, which is what tells you the blade has a section.
    for (let x = -h; x <= h; x++) v.set(x, y, 0, x === h ? C.steelLt : C.steel);
    v.set(0, y, 1, C.steelDk);
  }
  // Two chips out of the edges, at different heights, and a chamfer on the
  // shoulders of the point. A blade that has been in the ground is not
  // straight-edged, and an asymmetric pair of nicks is the cheapest way to say
  // so; the chamfer is what stops the tip reading as a chopped-off paddle.
  v.set(-1, 4, 0, C.steelDk);
  v.set(1, 6, 0, C.steelDk);
  v.set(-1, 8, 0, C.steelDk);
  v.set(1, 7, 0, C.steelDk); // one row up: a symmetric pair is an arrowhead
  const m = v.build(S, true);
  // build() zeroes y on the pommel, two rows below the grip, so the offset that
  // brings the GRIP back to the hand's origin is those two rows. It read +0.28
  // for one round — the length of the blade, copied from the wrong end — and
  // the sword floated a hand's width out of the fist on a long lever, which is
  // why the first capture had it sticking out sideways like an oar.
  m.position.y = -2 * S;
  return m;
}

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------
function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  root.add(body);
  parts.body = body;

  // -- legs: hip pivot -> knee pivot, the two-segment chain a biped needs --
  for (const side of [1, -1]) {
    const hip = new THREE.Group();
    // 2.5 cells out, which is the edge of the ilium. At 1.5 the femurs came out
    // of the MIDDLE of the pelvis and the hips read as one narrow post.
    // z is parted for the same reason x is at the knee — the femur's head sits
    // up inside the ilium, and unparted their front walls agree.
    // TWICE the parting in z. One step put the femur's front wall back on the
    // ilium's the moment the hip swung — the pelvis carries its own step in the
    // same direction, so a single step here cancels against it.
    hip.position.set(side * 2.5 * S, HIP_Y, 2 * JOINT_PART);
    hip.add(buildThigh());
    body.add(hip);
    const knee = new THREE.Group();
    // The parting ACCUMULATES down the chain rather than alternating: the knee
    // takes another step in z the SAME way the hip did, so the shin clears the
    // femur's walls and the skirt's. Sign it the other way and the two cancel,
    // which puts the shin back on the pelvis's grid — measured, not guessed.
    knee.position.set(side * JOINT_PART, KNEE_Y, JOINT_PART);
    knee.add(buildShin());
    hip.add(knee);
    parts[side > 0 ? 'hipR' : 'hipL'] = hip;
    parts[side > 0 ? 'kneeR' : 'kneeL'] = knee;
  }

  // -- pelvis, belt and skirt: fixed to the body, below the twisting torso --
  const pelvis = new THREE.Group();
  // Parted in z from the torso above it — see JOINT_PART. The belt's back wall
  // and the thoracic spine's both sit at the cage's own back plane, and the
  // pelvis is the one of the two that can move without dragging a limb with it.
  pelvis.position.set(0, PELVIS_Y, JOINT_PART);
  pelvis.add(buildPelvis());
  body.add(pelvis);
  parts.pelvis = pelvis;

  // -- torso: the lumbar twist pivot, carrying cage, head and both arms --
  const torso = new THREE.Group();
  torso.position.y = TORSO_Y;
  torso.add(buildRibcage());
  body.add(torso);
  parts.torso = torso;

  const head = new THREE.Group();
  // Parted in z only. It carried an x parting too for one round, to keep the
  // skull's side walls off the ribcage's — which worked, and put the head
  // permanently a third of a cell off the body's centreline, which is visible
  // on a bilaterally symmetric part. The cage is now four cells wider than the
  // skull at the shoulders and the walls no longer meet, so the x parting is
  // not needed and is not paid for.
  head.position.set(0, NECK_Y, JOINT_PART);
  head.add(buildSkull());
  torso.add(head);
  parts.head = head;

  const jaw = new THREE.Group();
  // The mandible is the one part that is the same width as the thing above it
  // and the same depth as the thing behind it, and it SWINGS, so it sweeps
  // through both planes over the course of a roar. Parted in x and z — see
  // JOINT_PART. A third of a cell on a part this small and this low in the
  // silhouette is invisible, which is why the jaw takes the parting and the
  // skull does not.
  jaw.position.set(JOINT_PART, -S, -JOINT_PART);
  jaw.add(buildJaw());
  head.add(jaw);
  parts.jaw = jaw;

  for (const side of [1, -1]) {
    const shoulder = new THREE.Group();
    // Parted BACKWARD where the neck is parted forward, so the pauldron and the
    // swinging mandible cannot agree on a plane either — see JOINT_PART.
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, -JOINT_PART);
    shoulder.add(buildUpperArm(side));
    torso.add(shoulder);
    const elbow = new THREE.Group();
    // INBOARD, where the knee's parting is outboard: parted outboard, the
    // forearm's inner wall landed exactly on the belt's outer wall as the arm
    // swung past the hip. The direction of a parting is free; that it exists is
    // not, and either sign parts the elbow from the humerus equally well.
    elbow.position.set(-side * JOINT_PART, ELBOW_Y, JOINT_PART);
    elbow.add(buildForearm(side));
    shoulder.add(elbow);
    parts[side > 0 ? 'shoulderR' : 'shoulderL'] = shoulder;
    parts[side > 0 ? 'elbowR' : 'elbowL'] = elbow;
  }

  // The sword hangs in the right fist. Its own group, so a pose can angle the
  // blade without touching the wrist — the rest pose lays it down past the calf
  // the way the hero's does, and every action branch re-aims it from here.
  const hand = new THREE.Group();
  // Parted in x from the forearm it hangs off — see JOINT_PART. The blade
  // sweeps up alongside the radius through the whole wind-up of a cleave, and
  // unparted its flat and the forearm's agree for most of that arc.
  // Carried FORWARD a cell and a half, so the seven-cell crossguard sits in
  // front of the thigh instead of beside it. Splaying the shoulder further
  // would do the same job and would also throw the walk's arm swing out; this
  // costs nothing but the offset.
  hand.position.set(-JOINT_PART, -6 * S, S * 1.5);
  // The REST pose, and it is stated here rather than left to animate() for a
  // reason: test-zfight builds rigs and never animates them, so an unrotated
  // sword hanging dead in line with the forearm parked the blade's flats on the
  // forearm's and the pauldron's own planes and reported two seams nobody would
  // ever see in game. The same numbers the idle branch uses; animate()
  // overwrites all three every frame.
  hand.rotation.set(3.00, 0.55, -0.10);
  hand.add(buildSword());
  parts.elbowR.add(hand);
  parts.hand = hand;

  return { root, parts, height: 1.84, radius: 0.30 };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

/** Integrated cycle slots — see BeastAnimCtx.cycle(). One gait is all a walking
 *  skeleton needs; the sway and the jaw run off the free clock at fixed rates. */
const GAIT = 0;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  // ---- idle: standing at rest, sword hanging, a slow settle in the knees ----
  let bodyX = 0;
  let bodyY = 0;
  let bodyZ = 0;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = 0;
  let torsoRY = Math.sin(t * 0.6) * 0.05;
  let torsoRX = 0;
  let headRX = Math.sin(t * 0.8) * 0.05 + 0.04;
  let headRY = Math.sin(t * 0.4) * 0.30; // a slow, dead-eyed scan of the field
  let headRZ = Math.sin(t * 0.55) * 0.04;
  let jawOpen = 0.06 + Math.sin(t * 1.4) * 0.03;
  // A skeleton does not breathe, so the idle life has to come from somewhere
  // else: a weight shift from one hip to the other, slow enough to read as
  // patience rather than as a sway. It drives the body roll AND the knees, so
  // the leg carrying the weight is the straight one.
  const shift = Math.sin(t * 0.7);
  bodyRZ = shift * 0.025;
  bodyY = -Math.abs(shift) * 0.008;
  let hipRXR = -0.04 + shift * 0.05;
  let hipRXL = -0.04 - shift * 0.05;
  let kneeRXR = 0.10 - shift * 0.06;
  let kneeRXL = 0.10 + shift * 0.06;
  let hipSplit = 0.05;
  let shRXR = 0.05 + Math.sin(t * 0.7) * 0.03;
  let shRXL = 0.05 - Math.sin(t * 0.7) * 0.03;
  // The sword arm gets its OWN split, and it is the fix for a defect that
  // survived two capture rounds: the blade hung in the same column as the right
  // shin from ricasso to tip and the character read as having three legs, one
  // of them grey. Rotating the blade at the wrist only changes its angle — the
  // GRIP has to move outboard, and that is the shoulder's job.
  let shSplitR = 0.20;
  let shSplitL = 0.12;
  let elRXR = -0.10;  // the sword arm hangs nearly straight, so the blade does
  let elRXL = -0.22;
  // Rest: the blade hangs DOWN beside the calf. The hand group's +Y is the
  // blade's own axis (buildSword puts the grip at the origin, point up +Y), so
  // "hanging" is near pi, not the 2.35 a first pass used — at 2.35 the sword
  // stood out sideways like an oar. The yaw keeps the flat of the blade off
  // square to the play camera so it never presents as a one-voxel plank.
  let handRX = 3.00;
  let handRY = 0.55;
  // A SMALL wrist angle, because the shoulder is what carries the blade clear
  // of the leg (shSplitR above). At -0.55 the wrist did the whole job and the
  // point swung out fifty degrees: the skeleton stopped hanging its sword and
  // started presenting it, which is a different pose and not this one.
  let handRZ = -0.10;

  switch (ctx.action) {
    case 'walk':
    case 'run':
    case 'fly':
    case 'swim': {
      const k = 0.5 + 0.5 * ctx.moveSpeed;
      // 4.4 rad/s at a trudge to 8.4 flat out — 0.7 to 1.35 strides a second,
      // which is a human cadence and reads as marching rather than scurrying.
      const w = ctx.cycle(GAIT, 4.4 + 4.0 * ctx.moveSpeed);
      const sw = Math.sin(w);
      const swB = Math.sin(w + Math.PI);
      // Legs. The hip swings the whole leg; the knee only bends on the RETURN
      // half of the stroke, which is what stops a biped walk looking like a
      // pair of scissors. `Math.max(0, ...)` is the whole trick.
      // 0.75, not 0.55. At 0.55 on a 0.42-long shin the foot travelled less
      // than its own length per stride and the walk read as a shuffle with a
      // lean in it; the contact has to be visible from the play camera.
      hipRXR = sw * (0.85 * k);
      hipRXL = swB * (0.85 * k);
      // The knee bends only on the RETURN half of the stroke, which is what
      // stops a biped walk looking like a pair of scissors. It was 1.05, which
      // folded the rear leg so far that it cancelled most of the stride the hip
      // had just opened and left the two legs looking near-parallel; 0.80 keeps
      // the trailing leg long enough to read as a step being taken.
      kneeRXR = 0.10 + Math.max(0, -sw) * (0.80 * k);
      kneeRXL = 0.10 + Math.max(0, -swB) * (0.80 * k);
      hipSplit = 0.04;
      // Body: two bobs per stride (the gait's second harmonic), and a lean into
      // the run. Derived from the same integrated phase, so it stays continuous
      // when the beast changes pace — see BeastAnimCtx.cycle().
      bodyY = -0.02 * k + Math.abs(Math.sin(w)) * 0.05 * k;
      bodyRZ = Math.sin(w) * 0.05 * k;
      bodyRX = 0.10 * k;
      // Counter-rotation through the spine: shoulders lead the hips by half a
      // stride. Without it the arms and legs swing as one slab.
      torsoRY = -sw * 0.20 * k;
      torsoRX = 0.05 * k;
      headRX = -0.10 * k + Math.sin(w * 2) * 0.03;
      headRY = Math.sin(t * 0.9) * 0.08;
      headRZ = sw * 0.05;
      jawOpen = 0.05;
      // Arms counter-swing the legs. The sword arm swings less — a heavy blade
      // does not pendulum — and its elbow stays more bent to keep the tip clear
      // of the ground.
      shRXR = swB * (0.32 * k);
      shRXL = sw * (0.48 * k);
      shSplitR = 0.18; // the sword arm stays out, or the blade walks through
      shSplitL = 0.08; // the shin it is hanging beside
      elRXR = -0.45 - Math.max(0, swB) * 0.25;
      elRXL = -0.30 - Math.max(0, sw) * 0.50;
      handRX = 2.95;
      handRY = 0.50;
      handRZ = -0.10;
      break;
    }
    case 'attack': {
      // An overhead cleave: wind up over the shoulder, drop it through, recover.
      // The wind-up is the frame this move is READ from — blade over the crown,
      // edge-on — and at 0.20s of wind against 0.13s of swing it existed for
      // about a fifth of a second. Three separate captures of a "mid-cleave"
      // came back showing the sword hanging at the hip, because that is what
      // the move looks like for most of its duration. Wind long, HOLD at the
      // top, then cut fast: 0.32 to raise it, 0.12 held, 0.10 through.
      const wind = easeOutCubic(clamp01(at / 0.32));
      const swing = easeOutCubic(clamp01((at - 0.44) / 0.10));
      const rec = easeInOutSine(clamp01((at - 0.56) / 0.34));
      const cut = swing * (1 - rec);
      const coil = wind * (1 - swing);
      bodyRX = -0.18 * coil + 0.42 * cut;
      bodyZ = -0.05 * coil + 0.20 * cut;
      bodyY = 0.03 * coil - 0.05 * cut;
      torsoRY = 0.55 * coil - 0.70 * cut; // the whole cut comes from the spine
      torsoRX = -0.20 * coil + 0.35 * cut;
      headRX = -0.20 * coil + 0.32 * cut;
      headRY = 0.25 * coil - 0.20 * cut;
      jawOpen = 0.15 * coil + 0.55 * swing * (1 - rec);
      // -2.05, not -2.70. At -2.70 the shoulder is 155 degrees past hanging and
      // the blade ends up a full body-length BEHIND the beast, where the play
      // camera cannot see it at all: the probe puts the sword at z = -1.14 for
      // the whole hold, and every capture of the wind-up came back looking like
      // an idle because the raised sword was hidden behind the torso. The
      // wind-up has to be UP and only a little back.
      shRXR = -2.05 * coil - 0.30 + 1.75 * cut; // sword arm goes overhead
      shRXL = 0.40 * coil - 0.55 * cut;
      // The split is CUT on the wind-up, not raised. Raised, the sword arm
      // swings clear of the body at the top of the swing and opens a visible
      // gap at the shoulder — a critic reading the attack frame logged the arm
      // as detached. A cleave is powered by the spine (torsoRY below), and the
      // arm stays in against the ribs while it winds.
      shSplitR = 0.14 + 0.10 * coil;
      shSplitL = 0.14 + 0.10 * coil;
      elRXR = -0.75 * coil - 0.20 + 0.85 * cut; // elbow stays open, so the blade
      // stands above the crown instead of folding down behind the shoulder
      elRXL = -0.60;
      // THE WRIST IS SOLVED, not keyframed. The shoulder and the elbow together
      // swing through more than three radians over this move, so a fixed wrist
      // angle points the blade somewhere different at every instant of the arc —
      // which is how a wind-up meant to raise the sword over the crown ended up
      // laying it a full body-length behind the beast, hidden by its own torso,
      // in three consecutive captures. State where the BLADE has to be in world
      // terms and subtract the arm: hanging at rest, straight up on the hold,
      // and down through the target on the cut.
      const bladeAngle = 3.05 - 2.80 * coil - 5.30 * cut;
      handRX = bladeAngle - (shRXR + elRXR);
      // handRY COUNTERS the spine's yaw rather than being zeroed: torsoRY has
      // already turned the whole upper body by the time the sword is overhead,
      // so a zero here presents the blade's flat square to the lens and the
      // wind-up photographed as a grey toolbox beside the skull.
      handRY = -0.55 * coil + 0.70 * cut;
      handRZ = -0.55 * coil + 0.35 * cut;
      hipRXR = 0.18 * coil - 0.30 * cut;
      hipRXL = -0.22 * coil + 0.34 * cut;
      kneeRXR = 0.30 * coil + 0.15 * cut;
      kneeRXL = 0.10 + 0.30 * cut;
      hipSplit = 0.16;
      break;
    }
    case 'cast': {
      // Bone-shard: the free hand comes up and flings something forward, and
      // the sword arm drops out of the way. Deliberately the OPPOSITE arm from
      // the attack, so the two silhouettes cannot be confused mid-fight.
      const gather = easeInOutSine(clamp01(at / 0.34));
      const throwT = easeOutCubic(clamp01((at - 0.50) / 0.14)); // held, then flung
      const settle = easeInOutSine(clamp01((at - 0.70) / 0.30));
      const g = gather * (1 - throwT);
      const f = throwT * (1 - settle);
      bodyRX = -0.20 * g + 0.24 * f;
      bodyY = 0.03 * g;
      torsoRY = -0.35 * g + 0.40 * f;
      torsoRX = -0.12 * g + 0.18 * f;
      headRX = -0.24 * g + 0.18 * f;
      headRY = -0.18 * g;
      jawOpen = 0.10 * g + 0.45 * f;
      shRXL = -1.55 * g - 0.10 - 1.05 * f; // gathers at the chest, flings out
      elRXL = -1.70 * g - 0.15 + 1.55 * f;
      shRXR = 0.30 * g + 0.10;
      elRXR = -0.35;
      shSplitR = 0.18;
      shSplitL = 0.18;
      handRX = 3.08;
      handRY = 0.50;
      hipRXR = -0.14 * g;
      hipRXL = 0.10 * g;
      kneeRXR = 0.22 + 0.18 * g;
      kneeRXL = 0.22 + 0.18 * g;
      hipSplit = 0.14;
      break;
    }
    case 'special': {
      // Grave-rites: sword thrust skyward, jaw open, the grave-light called up
      // through the whole frame. Held, then let down.
      const rise = easeOutCubic(clamp01(at / 0.32));
      const fall = easeInOutSine(clamp01((at - 0.90) / 0.36));
      const amp = rise * (1 - fall);
      const tremor = Math.sin(t * 22) * 0.02 * amp;
      bodyRX = -0.26 * amp;
      bodyY = 0.05 * amp + tremor;
      torsoRX = -0.24 * amp;
      torsoRY = Math.sin(t * 5) * 0.05 * amp;
      headRX = -0.55 * amp; // head thrown back
      headRY = 0;
      headRZ = tremor * 2;
      jawOpen = 0.85 * amp;
      shRXR = -2.75 * amp + 0.06; // straight up
      elRXR = -0.10 * amp - 0.20;
      shRXL = -1.15 * amp + 0.06;
      elRXL = -0.85 * amp - 0.20;
      shSplitR = 0.10 + 0.35 * amp;
      shSplitL = 0.10 + 0.35 * amp;
      handRX = 0.10 * amp;
      handRY = 0.15;
      hipRXR = -0.18 * amp;
      hipRXL = -0.18 * amp;
      kneeRXR = 0.30 * amp + 0.08;
      kneeRXL = 0.30 * amp + 0.08;
      hipSplit = 0.22 * amp + 0.05;
      break;
    }
    case 'hurt': {
      // A skeleton takes a hit by RATTLING — the parts jolt against each other
      // and settle. Higher frequency and lower amplitude than a flesh recoil.
      const d = Math.max(0, 1 - at / 0.5);
      bodyX = Math.sin(at * 58) * 0.03 * d;
      bodyRZ = Math.sin(at * 50) * 0.10 * d;
      bodyRX = -0.22 * d;
      bodyZ = -0.06 * d;
      torsoRY = Math.sin(at * 46) * 0.16 * d;
      torsoRX = 0.18 * d;
      headRX = 0.30 * d;
      headRZ = Math.sin(at * 54) * 0.14 * d;
      jawOpen = 0.35 * d + 0.05;
      shRXR = 0.55 * d + 0.06;
      shRXL = 0.60 * d + 0.06;
      shSplitR = 0.30 * d + 0.10;
      shSplitL = 0.30 * d + 0.10;
      elRXR = -0.75 * d - 0.20;
      elRXL = -0.75 * d - 0.20;
      handRX = 3.05 + 0.3 * d;
      hipRXR = 0.24 * d;
      hipRXL = 0.16 * d;
      kneeRXR = 0.42 * d + 0.10;
      kneeRXL = 0.34 * d + 0.10;
      hipSplit = 0.14 * d + 0.05;
      break;
    }
    case 'happy': {
      // It cannot smile, so the delight is all in the body: a clattering little
      // march on the spot with the sword punched up on every second beat.
      const hop = Math.abs(Math.sin(at * 6.0));
      bodyY = hop * 0.09;
      bodyRY = Math.sin(at * 3.0) * 0.35;
      bodyRZ = Math.sin(at * 6.0) * 0.07;
      torsoRY = Math.sin(at * 3.0) * 0.18;
      headRX = -0.14;
      headRZ = Math.sin(at * 6.0) * 0.16;
      headRY = Math.sin(at * 3.0) * 0.20;
      jawOpen = 0.30 + Math.sin(at * 12) * 0.20; // a dry, clattering laugh
      shRXR = -1.10 - Math.sin(at * 6.0) * 0.55;
      elRXR = -0.55;
      shRXL = -0.35 + Math.sin(at * 6.0) * 0.55;
      elRXL = -0.75;
      shSplitR = 0.28;
      shSplitL = 0.28;
      handRX = 0.35;
      handRY = 0.20;
      hipRXR = Math.sin(at * 6.0) * 0.34;
      hipRXL = Math.sin(at * 6.0 + Math.PI) * 0.34;
      kneeRXR = 0.15 + Math.max(0, -Math.sin(at * 6.0)) * 0.85;
      kneeRXL = 0.15 + Math.max(0, Math.sin(at * 6.0)) * 0.85;
      hipSplit = 0.08;
      break;
    }
    case 'idle':
    default:
      break;
  }

  // ---- apply ----
  const body = p.body;
  body.position.set(bodyX, bodyY, bodyZ);
  body.rotation.set(bodyRX, bodyRY, bodyRZ);

  p.torso.rotation.set(torsoRX, torsoRY, 0);
  p.head.rotation.set(headRX, headRY, headRZ);
  p.jaw.rotation.x = jawOpen;

  // The SIGN of a split, and it cost a capture round to get right. A limb hangs
  // along its own -Y, and Rz(t) takes (0,-1) to (sin t, -cos t) — so a POSITIVE
  // z rotation swings a limb toward +x. The right side is at +x, so the right
  // side takes the positive sign to splay OUTWARD. Written the other way round
  // (which is the way that looks symmetric in source) both arms fold across the
  // belly, and the capture showed a skeleton hugging its own belt with the
  // sword hilt somewhere in the middle of it.
  p.hipR.rotation.set(hipRXR, 0, hipSplit);
  p.hipL.rotation.set(hipRXL, 0, -hipSplit);
  p.kneeR.rotation.x = kneeRXR;
  p.kneeL.rotation.x = kneeRXL;

  p.shoulderR.rotation.set(shRXR, 0, shSplitR);  // see the note on hipSplit
  p.shoulderL.rotation.set(shRXL, 0, -shSplitL);
  p.elbowR.rotation.x = elRXR;
  p.elbowL.rotation.x = elRXL;

  p.hand.rotation.set(handRX, handRY, handRZ);
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: BeastSpecies = {
  id: 'graveborn',
  nameKey: 'beast.graveborn.name',
  element: 'shadow',
  locomotion: 'ground',
  descriptionKey: 'beast.graveborn.desc',
  baseStats: { maxHp: 52, attack: 16, defense: 11, speed: 5.0 },
  skills: [
    'graveborn.rusted-cleave',
    'graveborn.bone-shard',
    'graveborn.grave-ward',
    'graveborn.last-rites',
  ],
  buildRig,
  animate,
};
