import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Graveback — issue #117. The undead quadruped: a heavy, low-slung barrow beast
// with a bone skull for a head, its own ribs grown out through its back, and a
// tattered grave-shroud still knotted over its shoulders. Grave-light burns in
// the sockets and in the cracks between its plates, the same cold cyan the
// Graveborn carries — they are two halves of one set and the palettes rhyme on
// purpose, but nothing is shared in code: a body is code and a colour belongs to
// the species file that paints it (see the note on ALL_SPECIES in
// combat/enemies.ts).
//
// Voxel scale 0.07. The roster's usual 0.1 is right for a fox-sized animal and
// this is not one: the ribs are a LATTICE standing proud of the flank and the
// skull carries a socket, a nasal void and a tooth line, and at 0.1 each of
// those is one or two cells and none of them survives. 0.07 puts about fifteen
// cells between paw and dorsal plate, which is the density the reference sheet
// is drawn at, without going so fine that a leg bone becomes a thread — that is
// the mistake the Graveborn made at 0.045 and it is documented there.
//
// Model faces +Z. Root origin at ground level, ~1.03 units to the dorsal
// plates and ~1.4 to the tip of the horn.
// ---------------------------------------------------------------------------

const S = 0.07;

// Palette.
//
// FLESH IS A WARM SLATE, not a neutral grey. The only light on a shaded face in
// this game is blue sky bounce, so a neutral stone tone RENDERS blue — that is
// boulderpup's hard-won note and it applies to every grey-bodied thing since.
// The reference sheet's hide is genuinely blue-slate, which means the tone has
// to be steered warm to LAND there rather than authored there and drifting past
// it into cyan, where it would also collide with the grave-light.
//
// The range matters as much as the hue. Lit crest to deep shadow is about
// 2.6:1 here, which is deliberate: boulderpup spent four rounds fixing a
// "dog-shaped hole" by raising every tone and arrived at 1.6:1, a beige lump
// with no legible head. A body needs a real shadow, not an absent one.
const C = {
  // Measured off a game capture and raised a full stop. The first set rendered
  // at 50 luminance and 2% saturation — a NEUTRAL OLIVE, not the blue-slate the
  // sheet has — against bone at 221, which is a 4.4:1 split with nothing in
  // between: at twenty metres that is a cream mass floating over a black hole.
  // The violet has to be in the hex, not hoped for from the light.
  flesh: 0x7a828f,       // the hide, between the plates
  fleshLt: 0x9aa2b4,     // sunlit crest along the spine and the haunches
  fleshDk: 0x5e6472,     // underside and the far flank
  fleshDp: 0x474d5a,     // deepest: under the barrel, inside the rib gaps
  // A step down from 0xded2ae. Every round of fixes added bone — a taller
  // cranium, longer ribs, a five-segment tail, bigger leg plates — until the
  // 20 m downsample was a beige lump: about 70% of the animal's screen area was
  // cream against a reference nearer 45% slate, 35% bone, 20% cloth. The way
  // back is to take bone DOWN, not to add hide.
  bone: 0xcdbf98,        // skull, ribs, plates, claws — warm cream
  boneLt: 0xe6dcc0,      // crown of the skull, top edge of every rib. Not
  // 0xf4ead0: the sunlit crown clipped, and a clipped crest carries no shape.
  boneDk: 0xb5a683,      // undersides, the far half of every rib arc
  boneDp: 0x8e805f,      // joint shadow, the mouth line, the crack floors
  // The socket and the nasal void. A very dark BROWN, never black — pure black
  // punches a hole in the silhouette (see eyes2x2's own note), and on a skull
  // this pale a hole is all anyone sees.
  socket: 0x241f18,
  // Grave-light. Emissive, and LOW — a bloom pass is downstream of this and a
  // blown iris is a headlamp. Same cold cyan as the Graveborn's sockets.
  glow: 0x3fd8e2,
  glowLt: 0xa8f2f6,      // catchlight inside the light, not emissive
  // The shroud. Desaturated crimson: at full saturation it is the only chromatic
  // mass on a grey-and-cream animal and it takes the whole frame — the same trap
  // the Graveborn's leather fell into as orange plastic.
  cloth: 0x7b3a46,
  clothLt: 0x99505c,     // sunlit top of the drape and of every wrap
  clothDk: 0x5a2932,     // the ragged hem, and under a wrap. Not lower: below
  // about 0x48 this game's 4.9:1 sun-to-fill ratio crushes a tone to black.
} as const;

/**
 * Emissive intensity on the grave-light. See the note on C.glow.
 *
 * The EYES run lower than the body seams, not higher. They are the brightest
 * thing on the animal by position and contrast already — two cells of cyan in a
 * black socket on a pale skull — and at the body's intensity the bloom pass
 * smeared them past the socket onto the slate behind, which erases the recess
 * the socket exists to be.
 */
const GLOW = 0.45;
const EYE_GLOW = 0.38;

// Base pose constants — shared between buildRig() and animate(), because a
// number that appears in both is a pose that drifts the day one of them moves.
// 0.32, not 0.42. At 0.42 on an animal a metre tall, 42% of its height was
// daylight under the belly and the four legs read as stove pipes holding a box
// up. The reference's belly sits near 30% and the legs are short, thick and
// crowded under the mass — that crowding is most of what makes it read heavy.
const BODY_Y = 0.32;       // underside of the barrel, above the root
const HEAD_Y = 0.20;       // within the body group
// 0.28, not 0.42. At 0.42 the skull sat at the same depth as the forelegs, so
// it occluded the entire chest: the front capture read as a mask on a post with
// two stumps under it, and no part of the barrel, the ribs or the shroud
// appeared in the silhouette at all. Pulled back and lifted, the shoulder mass
// stands outboard of the skull and there is an animal behind the face.
const HEAD_Z = 0.28;       // within the body group — the head carries FORWARD,
// and low: this is a beast that walks with its skull down at knee height, which
// is most of what makes it read as a hunting animal rather than as a statue.
const HEAD_PITCH = 0.22;   // nose-down at rest
const LEG_Y = 0.32;        // hip and shoulder joints, above the root
// 0.25, not 0.55. Folded up over the rump the tail landed in the middle of the
// rump plates, the same colour and roughly the same size as the horn, and the
// beast appeared to have two horns. Carried out behind, it is a tail.
const TAIL_UP = 0.25;

/**
 * THREE TENTHS OF A VOXEL, and it is the whole reason this rig is seam-free.
 *
 * `VoxelModel.build` puts every face on a multiple of S re-based on the model's
 * own bounds, so two parts land on ONE world grid — and every one of their
 * faces is a candidate pair — whenever the joint between them is a whole
 * multiple of S in that axis. A quadruped is full of those: four legs meeting
 * one barrel, a skull sitting on a neck, three tail segments in a line.
 *
 * Three tenths and not a half. A half cancels against `build(center = true)`'s
 * own re-basing — a part whose cell span is even already carries a half-cell
 * shift — so a half-cell parting can put two walls back onto the same plane
 * rather than off it. That cost the Graveborn a capture round; it is written
 * down here so this rig does not pay for it twice.
 *
 * On screen it is 21 mm on an animal a metre tall: nothing. The direction of
 * each parting is free, and several of them below were signed the other way
 * first — a parting that cancels its parent's simply moves the pair one link on.
 */
const JOINT_PART = S * 0.3;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Voxel parts
//
// EVERY PART'S CELL SPAN IS SYMMETRIC IN X. `build(center = true)` re-bases a
// mesh on its own bounding box, so a part whose x span is symmetric lands on its
// group's origin and a part whose span is lopsided lands half a cell off it. On
// a PAIR — two ears, four legs — that is the difference between a pair and a
// pair that has drifted, and it is invisible in source and obvious in a
// capture. Where a part needs an asymmetric detail (the outboard face of a leg
// plate), the detail stays INSIDE the symmetric span.
// ---------------------------------------------------------------------------

/**
 * The arc ONE rib takes, as [y, dz] steps out from the spine.
 *
 * A rib on this animal is a curve in the Y/Z plane — up out of the spine, over
 * the top of the flank and down toward the elbow — and it is painted on the
 * SIDE of the barrel, two cells thick, so it stands proud of the hide.
 *
 * It was an ellipse shell in the X/Y plane for two builds: a hoop over the
 * back. That is a defensible shape for a ribCAGE and it is the wrong one here,
 * and the profile capture is what showed it — a hoop seen from the side is
 * edge-on, so all three of them rendered as short vertical spikes along the
 * spine and the animal grew a mohawk. The bearing a quadruped is read from is
 * broadside, and the rib has to be an arc AT that bearing.
 *
 * It has to travel further in Z than a rib is tall, or it is a stave and not an
 * arc. The first version stepped five in Y against two in Z — near vertical —
 * and three of those side by side, plus the spine plates, merged into one
 * unbroken cream slab down the whole back. This one falls from the spine and
 * sweeps BACK, four cells of Z over six of Y, and runs long enough to reach the
 * elbow line the way the reference sheet's do.
 *
 * Hand-listed rather than generated, because it is one shape used three times
 * and every step of it is face-connected on purpose: a staircase joined only at
 * its diagonals bakes as a dotted line of loose cubes.
 */
const RIB: ReadonlyArray<readonly [number, number]> = [
  [7, 0], [7, 1], [6, 1], [6, 2], [5, 2], [5, 3], [4, 3], [3, 3], [2, 3], [1, 3],
];

/** Stamp one rib pair, with its root at depth `cz` along the spine. */
function ribArc(v: VoxelModel, cz: number): void {
  for (const sx of [1, -1]) {
    for (let i = 0; i < RIB.length; i++) {
      const [y, dz] = RIB[i];
      // Two cells thick: the inner one is buried in the hide and holds the rib
      // ON the animal, the outer one is what the camera sees. Lit along the top
      // of the arc and falling to the deep tone at the free end, so a rib reads
      // as a curve rather than as a bar.
      const tone = i < 2 ? C.boneLt : i < 6 ? C.bone : C.boneDk;
      // x = 5 is INSIDE the hide (the barrel reaches |x| = 5) and x = 6 stands
      // proud of it. The first version painted 5 and 6 against a barrel that
      // only reached 5 at one height, so each arc touched the animal at a single
      // cell and the flank grew a free-standing picket fence. Face-connected is
      // not the same as visually seated, and test-zfight only checks the first.
      v.set(sx * 5, y, cz + dz, tone);
      // The proud column stops halfway down: a rib two cells thick for its whole
      // length is a slab, and three slabs are a picket fence however far apart
      // they are spaced. Thinning it toward the elbow is also what a rib does.
      if (i < 5) v.set(sx * 6, y, cz + dz, tone);
    }
    // Grave-light where the rib leaves the spine — the one place on the body,
    // besides the sockets, that the light is allowed to be.
    v.setEmissive(sx * 5, 7, cz, C.glow, GLOW);
  }
}

/** A wrap of shroud-cloth: a closed band round a limb or a barrel. Lit on top.
 *
 *  A band is a RING with nothing in the middle of it, so whatever it is tied
 *  around has to actually be there. A wrap painted at a height where the limb
 *  below it has already stopped is eight cells joined to the rest of the model
 *  only at their diagonals, and `build()` bakes it as a floating hoop — that
 *  shipped for a round on the Graveborn and a critic read it as detached
 *  geometry. Every caller here runs the limb THROUGH the wrap's rows. */
function wrap(v: VoxelModel, y: number, w: number, d: number, rows = 2): void {
  for (let r = 0; r < rows; r++) {
    for (let x = -w; x <= w; x++) {
      for (let z = -d; z <= d; z++) {
        if (Math.abs(x) < w && Math.abs(z) < d) continue; // a band, not a block
        v.set(x, y + r, z, r === rows - 1 ? C.clothLt : C.cloth);
      }
    }
  }
}

/**
 * The barrel: hide, the bone plates studding it, the three rib arcs a side, the
 * grave-shroud over the shoulders and the wrap round the waist — ONE grid.
 *
 * One grid and not six because none of them move relative to each other: the
 * body group is the only pivot back here. It is also the only way a rib
 * standing proud of a flank can be guaranteed not to z-fight against the flank
 * it stands proud of — `build()` drops every face between two touching cells,
 * so within one model a coincident pair is impossible rather than unlikely.
 * Six meshes would be six draw calls for a shape that never separates.
 */
function buildTorso(): THREE.Mesh {
  const v = new VoxelModel();

  // -- the hide: three overlapping masses, deepest at the shoulder. A single
  // ellipsoid is a sausage; the step down from shoulder to waist to haunch is
  // what gives a four-legged animal a direction to face.
  //
  // ELEVEN CELLS ACROSS and fifteen long, against a skull nine across. The
  // first build had the barrel nine and the skull thirteen — a head WIDER than
  // the body it is on — and the capture came back as a skull with a small grey
  // animal hiding behind it. On the reference sheet the body is the bigger mass
  // in every axis, and the head is what is carried out in front of it.
  // Shallower than it is long: ry 3.2 against rz 7.4. The first pass gave the
  // barrel the same depth as its width and the animal came back as a cube on
  // four pegs — a heavy quadruped is a LONG body carried low, and the reference
  // sheet's is half again longer than it is tall at the shoulder.
  v.ellipsoid(0, 4.0, -1.0, 5.8, 3.6, 8.4, C.flesh);
  // The shoulder is a WITHERS HUMP behind and above the skull, not a collar
  // round it. Carried forward to z = 5.4 it reached torso cell 9 — two cells in
  // front of the cranium's own face plane — and the hide came out THROUGH the
  // eye line: the game capture had two slate bars across the middle of the
  // skull with the grave-light pinched into slivers behind them. There is no
  // erase in VoxelModel, so the guard against this is arithmetic and it belongs
  // written down: the mass must end behind `HEAD_Z + (skull front cell) * S`,
  // which is 0.58, and at cz 3.4 with rz 3.0 it ends at 0.49.
  v.ellipsoid(0, 5.2, 3.4, 5.4, 3.8, 3.0, C.flesh);   // withers
  v.ellipsoid(0, 3.8, -6.6, 5.2, 3.4, 3.4, C.flesh);  // haunches
  rimTop(v, C.fleshLt, -5, 5, 6, 9, -11, 10);
  // Clamped to the belly's own length. Run the full depth of the model, the
  // underside band came out as a hard horizontal stripe across the rump and the
  // rear view read as a grille on a machine.
  shadeUnder(v, C.fleshDp, -5, 5, 0, 1, -7, 6);

  // -- the cracks. This is the single strongest "dead and lit from inside" cue
  // on the reference sheet and the first build had six emissive cells on the
  // whole animal, four of them behind the brow where no play angle sees them.
  // Short seams down the flank and across the haunch, at HALF the eyes' glow so
  // they never compete with the face for the eye.
  // Each seam is a RUN of face-connected cells stepping down and forward, not a
  // lone cell: single cells at this scale are three discrete cyan squares on the
  // flank and they read as indicator lamps rather than as a crack.
  const seams: Array<[number, number, number]> = [
    [5, 5, -2], [5, 4, -3], [5, 4, -4],
    [5, 3, -6], [5, 2, -7],
    [4, 5, -10], [4, 4, -10],
  ];
  for (const [x, y, z] of seams) {
    for (const sx of [1, -1]) v.setEmissive(sx * x, y, z, C.glow, GLOW * 0.55);
  }

  // -- bone plates studding the spine and the flanks. Chunky and IRREGULAR:
  // evenly spaced same-sized cubes read as rivets on a machine, and this is
  // supposed to be bone pushing through from underneath.
  // NOT in the rib zone. The first pass studded the whole spine, so over the
  // middle of the back a rib arc, a spine plate and a flank plate all landed
  // within a cell of each other and the profile came back as a bone BUSH with
  // no arcs legible in it. Bone is the loudest material on this animal; it has
  // to be given room. Plates live behind the ribs, on the rump, and on the
  // withers in front of them — nowhere else.
  // TWO big shards on the rump, not four small ones. Four gave the arcs no
  // daylight to be read against, and small evenly-spaced cubes read as rivets
  // on a machine rather than as bone pushing through from underneath.
  const plates: Array<[number, number, number]> = [
    [0, 7, -7], [2, 6, -9],
  ];
  for (const [x, y, z] of plates) {
    for (const sx of x === 0 ? [1] : [1, -1]) {
      v.box(sx * x, y, z, sx * x, y + 1, z, C.bone);
      v.set(sx * x, y + 1, z, C.boneLt);
    }
  }

  // -- the ribs. THREE a side, three cells apart so daylight shows between
  // them, and sitting BEHIND the shroud rather than under it. They were under it
  // for one build and the profile came back with no ribs on it at all — which is
  // most of what this animal is. On the reference sheet the drape is over the
  // shoulders and the bare ribs are the mid-flank, in that order front to back.
  // w = 7 against a barrel half-width of 5, and rooted at y = 2 rather than at
  // the spine: the arc has to START outside the hide and low on the flank, or
  // only its topmost cells clear the body and three ribs photograph as a row of
  // spikes along the back — a mohawk, which is what the first two builds had.
  // Four apart, for an arc three cells deep: at three apart the trailing edge
  // of one rib touched the leading edge of the next and the flank came back as
  // a solid sheet of bone. A cage is the GAPS.
  ribArc(v, -1);
  ribArc(v, -5);
  ribArc(v, -9);

  // -- the shroud. A cap over the withers with a panel falling down each flank,
  // and the hem is RAGGED per column — a hem that steps evenly down to a point
  // reads as a cut edge, and this is cloth that has been in the ground. The
  // notch (the column that jumps back UP, at i = 3) is what says torn.
  // The cap follows the crown of the shoulder rather than lying flat, and its
  // ends are ragged in z per column. A 9 x 4 rectangle at one y is a plank: the
  // capture read it as an awning, and the uniform lit strip along its straight
  // front edge was what made it look machined.
  // BEHIND the skull and BELOW its crown. The head moved back to sit on the
  // shoulders and the drape was moved twice chasing it: once it framed the face
  // like a hood, and once it came to rest ON the cranium as a red tile. It sits
  // over the withers now, which is where a shroud knotted at the neck falls.
  const capTop = [7, 8, 8, 7];
  for (let i = 0; i < 4; i++) {
    const z = 1 - i;
    const w = i === 0 ? 3 : 4;
    for (let x = -w; x <= w; x++) v.set(x, capTop[i], z, i >= 2 ? C.clothLt : C.cloth);
  }
  // FOUR columns falling five cells at most, not six falling eight. The first
  // drape reached the belly over most of the barrel's length: in profile it was
  // a red blanket with an animal's legs under it, and it was covering the ribs
  // as well. A shroud is over the shoulders and it is the second-biggest thing
  // on the body, never the first.
  // SIX columns falling as far as the elbow, with a notch cut into them. Four
  // columns falling four cells put no cloth at all in the front silhouette and
  // left the drape as an edge-on line; a shroud is the second-biggest mass on
  // this animal and it has to hang.
  // The fall hangs from the CAP's own height per column, not from a fixed row,
  // and it hangs in front of the first rib rather than across all three: a
  // shroud painted down the same columns the ribs occupy reads as red streaks
  // between bone slabs instead of as one hanging mass.
  const fall = [3, 6, 2, 5];
  for (let i = 0; i < fall.length; i++) {
    const z = 1 - i;
    const topY = capTop[i];
    for (const sx of [1, -1]) {
      for (let d = 0; d < fall[i]; d++) {
        const y = topY - d;
        v.set(sx * 5, y, z, d === fall[i] - 1 ? C.clothDk : C.cloth);
      }
      v.set(sx * 5, topY, z, C.clothLt); // the fold where the drape turns over
    }
  }

  // -- the waist wrap: one band of the same cloth round the barrel, which is
  // what ties the shroud to the animal rather than leaving it a loose sheet.
  for (let x = -5; x <= 5; x++) {
    for (let z = -3; z >= -4; z--) {
      for (let y = 1; y <= 6; y++) if (v.has(x, y, z)) v.set(x, y, z, y >= 5 ? C.clothLt : C.cloth);
    }
  }

  // No y offset: `build()` already zeroes the mesh on its lowest cell, and the
  // body group's own BODY_Y is what lifts the barrel off the ground. Subtracting
  // BODY_Y here as well put the underside back down at ground level, which is
  // where the first build had it — the legs had nothing to hold up.
  return v.build(S, true);
}

/**
 * The skull: cranium, brow, muzzle, cheek spurs, ear plates and the horn, as one
 * mesh. None of them articulate — only the mandible does, and that is its own
 * group below.
 *
 * THREE TONES ON THE FACE. Earlier work on the Graveborn's skull carried a lit
 * cheekbone, a shaded cell under it, a half-value lid over each eye and teeth
 * drawn as alternating light and dark cells; every one is defensible alone and
 * together, inside a face this size, they came back from the capture as a
 * light/dark chequer that read as a corrupted texture. Pale bone, two black
 * holes and one line of teeth is the whole of what survives at play distance.
 */
function buildSkull(): THREE.Mesh {
  const v = new VoxelModel();

  // -- cranium, stepped in at the crown so the top of the head is not a lid.
  // SEVEN cells across against the barrel's eleven, and seven rows tall against
  // its eight. The head is the second mass, never the first: it was thirteen
  // across for one build, wider than the body it sits on, and the capture came
  // back as a skull with a small grey animal hiding behind it. Nine was still
  // enough to swallow the chest from the front.
  // NINE across, and the ninth cell is not decoration: the socket is painted at
  // |x| = 2..3, and a seven-wide cranium puts x = 3 on the skull's own outer
  // WALL. `VoxelModel` colours cells, not faces, so that socket cell then shows
  // dark on its side too — the profile came back with a black rectangle on the
  // cheek that read as a hole through the head. One more column of bone
  // outboard of the socket and the hole is a hole in the FACE, where it belongs.
  // TAPERED, not a block. Nine by seven by eight with one inset row is a
  // helmet: it hangs square-cornered over the face, and its roof is the largest
  // flat lit plane on the animal, which drags the eye off everything else. The
  // rows above the eye line step BACK off the face as well as narrowing, so the
  // brow recedes instead of cantilevering.
  for (let y = 2; y <= 8; y++) {
    const w = y >= 8 ? 2 : y >= 7 ? 3 : 4;
    const front = y >= 7 ? 2 : 3;
    v.box(-w, y, -4, w, y, front, C.bone);
  }
  // A shaded channel down the midline of the roof, so the crown is not one
  // unbroken highlight.
  for (let z = -4; z <= 2; z++) v.set(0, 8, z, C.boneDk);
  // -- muzzle: narrower and shallower, dropping forward off the face.
  v.box(-2, 1, 2, 2, 4, 5, C.bone);
  v.box(-2, 0, 3, 2, 0, 5, C.bone); // the palate under it
  rimTop(v, C.boneLt, -4, 4, 7, 8, -4, 5);
  shadeUnder(v, C.boneDk, -4, 4, 0, 1, -4, 5);

  // -- the crack. One cyan line down the forehead, and ONE: two would read as
  // damage decals rather than as a skull that has been broken and kept going.
  for (const [y, z] of [[8, 0], [7, 1], [7, 2], [6, 3]] as const) {
    v.setEmissive(0, y, z, C.glow, GLOW);
  }

  // -- the face, on the cranium's front wall at z = 3, which is where a
  // long-muzzled skull carries its sockets: above and BEHIND the snout and
  // outboard of it, so both are presented at once from the front.
  //
  // The socket is a hole three cells wide and three tall with the light two
  // columns inside it. That ratio is the whole read: an iris that fills its
  // socket leaves no dark anywhere around the glow, the recess then exists only
  // in the source, and the capture comes back with cyan letterboxes glued to a
  // pale box — a face in ski goggles and not a skull.
  // Rows 3-5, not 2-4. The cheek spur below now juts FORWARD, and at the lower
  // placement it stood in front of both sockets: the game capture came back with
  // a skull that had a mouth and no eyes at all. A feature that occludes the one
  // thing the face is read by has to move, or the face does.
  // Rows 4-6, ABOVE the muzzle. They were at 2-5 for two builds, and the muzzle
  // spans rows 1-4 out to |x| = 2 in front of the face plane — so the inner half
  // of each iris was INSIDE the snout, its faces culled by build() as interior,
  // and the game capture came back with a skull whose eyes did not light. A
  // socket has to be painted where the camera can reach it.
  //
  // And it needs WALLS. There is no erase in VoxelModel, so a recess cannot be
  // cut — it has to be built by standing the bone either side of it proud: the
  // nasal ridge at x = 0 below, and a cheek ridge at |x| = 4 here. Between two
  // proud walls the socket is a hole; without them it is a dark rectangle
  // painted on a flat face, which is what three builds of this head shipped.
  for (const sx of [1, -1]) {
    for (let y = 4; y <= 6; y++) v.set(sx * 4, y, 4, C.bone);
    v.set(sx * 4, 6, 4, C.boneLt);
  }
  for (const sx of [1, -1]) {
    for (let d = 1; d <= 4; d++) {
      for (let y = 4; y <= 6; y++) v.set(sx * d, y, 3, C.socket);
    }
  }
  // A TWO-cell iris, not one. One column is 70 mm on a head 630 wide — 11% of
  // the face — and the capture came back with two cyan slivers under the brow
  // where the reference sheet has the animal's single loudest feature. The
  // socket stops at |x| = 3 so the cranium's outer column stays bone: a socket
  // cell painted on the skull's own side wall shows dark from the flank too,
  // and the profile then has a black rectangle punched through the cheek.
  // TWO columns of iris in a socket four wide. One column at a lowered glow was
  // the previous swing of the pendulum and the game capture came back with no
  // eyes at all — a skull with a mouth and two dark smudges. The socket is what
  // makes the recess; the iris is what has to be seen.
  eyes2x2(v, {
    inner: 2, width: 2, y: 5, faceZ: 3,
    iris: C.glow, glow: EYE_GLOW, shine: C.glowLt,
  });
  // Three cells of lit bone between the sockets, standing proud at the centre.
  // One cell of ridge is 70 mm on an animal a metre tall — under a pixel at
  // fifteen metres — and the two holes bridge into a single dark band across the
  // face, which reads as a visor with a light at each end.
  // ONE column of ridge now that the sockets have taken the two either side of
  // it, and it stands PROUD for all three rows to pay for the width it lost: a
  // flush single cell is the sub-pixel detail that let two sockets bridge into
  // one dark band across the face, and a raised one throws its own shadow.
  for (let y = 4; y <= 6; y++) {
    v.set(0, y, 3, C.boneLt);
    v.set(0, y, 4, C.boneLt);
  }
  // Brow: a shaded row over both sockets, standing a cell proud, stopping short
  // of the temples. A brow that runs wall to wall is a headband.
  // FLUSH, not proud. A brow standing a cell forward of the face plane hangs
  // directly over the sockets, and the play camera looks DOWN at an animal a
  // metre tall: the game capture came back with the whole eye line in the brow's
  // own shadow and no grave-light visible at all. On a creature this size the
  // camera is above the brow, so relief there costs the eyes and buys nothing.
  for (let x = -2; x <= 2; x++) v.set(x, 7, 3, C.boneDk);

  // -- nasal aperture: a triangle pointing DOWN on the front of the muzzle, and
  // the mouth is a dark recess a row under it with the teeth hung in it. Pale
  // teeth flush in a pale face vanish at every distance; cut the gap first, then
  // hang them in it. The nose was drawn point-UP for one build and it merged
  // with the mouth into a single black T that read as a keyhole.
  // ONE column, two rows, and a clear row of bone between it and the tooth line.
  // Three cells over one is a T at this resolution and a T in the middle of a
  // face reads as a keyhole; so does a vertical slot sitting directly on top of
  // a dark mouth row, which is what the second attempt produced.
  v.set(0, 5, 5, C.socket);
  v.set(0, 4, 5, C.socket);
  v.set(0, 3, 5, C.boneDk); // one shaded row under it, so the slot is seated
  for (let x = -2; x <= 2; x++) {
    v.set(x, 1, 5, C.socket);
    if (x % 2 === 0) v.set(x, 1, 6, C.boneLt);
  }

  // -- cheek spurs: bone growing out sideways under each eye, which is the
  // reference's strongest head shape after the horn and the only thing that
  // stops the skull being a box in profile.
  // The spur juts FORWARD and DOWN rather than sideways. Out to the side it was
  // the widest thing on the head, and the head then had to be threaded between
  // the barrel's ribs and the near foreleg with a fifth of a cell either side —
  // a clearance the gait's own 3% squash sweeps straight through. Forward, it
  // is the same shape in profile, it costs nothing in width, and it reads
  // better: this is a jaw buttress, not a horn.
  for (const sx of [1, -1]) {
    v.box(sx * 4, 0, 1, sx * 4, 2, 4, C.bone);
    v.box(sx * 4, 2, 1, sx * 4, 2, 4, C.boneLt);
    v.set(sx * 4, 0, 4, C.boneDk);
    v.set(sx * 4, 0, 1, C.boneDk);
  }

  // -- ear plates: flat bone flaps on the upper corners, swept back.
  for (const sx of [1, -1]) {
    v.box(sx * 4, 7, -2, sx * 4, 10, 0, C.bone);
    v.set(sx * 4, 10, -1, C.boneLt);
    v.set(sx * 4, 7, -2, C.boneDp);
  }

  // -- the horn: a single spike off the back of the crown, swept up and back,
  // with a dark wrap where it leaves the bone. It is the tallest thing on the
  // animal and it does most of the silhouette work at distance.
  // A TAPERED TUSK: three cells wide at the root narrowing to one at the point,
  // every step moving one in y and one in z so the line is a continuous
  // diagonal. The first horn stepped twice in z at one height and presented
  // front-on as a light cross with a loose cube under it — a crucifix, which is
  // the tallest thing on the animal doing entirely the wrong work.
  // Two cells of z per one of y up the top half, so the horn LIES BACK at about
  // sixty degrees the way the reference sheet's does. Stacked near-vertically it
  // was a chimney with notches in it, and its last three rows — one cell each,
  // joined on one-cell faces — read as detached cubes.
  const spine: Array<[number, number, number]> = [
    [9, -2, 1], [10, -3, 1], [10, -4, 1], [11, -5, 1], [11, -6, 0], [12, -7, 0],
  ];
  for (const [y, z, w] of spine) {
    v.box(-w, y, z, w, y, z, C.bone);
    v.set(0, y, z, C.boneLt);
  }
  // Bound at the root: two rows wrapping the front and the sides, so the horn
  // reads as lashed on rather than grown.
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
  // The mouth line, on the FRONT face only — under the maxilla's teeth.
  for (let x = -2; x <= 2; x++) v.set(x, 1, 5, C.boneDp);
  return v.build(S, true);
}

/**
 * A leg. `front` picks the shoulder or the haunch shape; `dir` is +1 for the
 * right side, and it only ever moves a detail INSIDE the part's symmetric span
 * — see the note at the top of this section for what a lopsided span costs.
 *
 * Three cells across, which is the reference sheet's proportion on an animal
 * this heavy, and two deep with the paw longer than the leg is thick so it has
 * a direction. A leg thinner than this was tried on the Graveborn at a finer
 * scale and vanished at play distance; the lesson is that a limb has to be read
 * against the BODY behind it, not against a grey card.
 */
function buildLeg(front: boolean, dir: number): THREE.Mesh {
  const v = new VoxelModel();
  // The top of the leg runs FOUR cells past the hip pivot, not one. At one, a
  // 0.6 rad hip swing lifted the top corner most of a cell and the leg came off
  // the body: the walk capture had daylight between the shoulder and the barrel
  // on both near legs. A limb has to stay buried through its whole arc.
  const top = front ? 10 : 9;
  v.box(-1, 1, -1, 1, top, 1, C.flesh);
  // A rounded shoulder or haunch: wide at the top, three cells at the ankle. An
  // untapered pipe is a table leg and four of them under a heavy body is
  // furniture, which is what the first capture had. ROUNDED rather than a boxy
  // step, because a box stepping from three cells to five leaves one long
  // DOWN-facing ledge at |x| = 2 and the barrel's own underside bobs across it
  // every frame — no fixed clearance survives a moving plane. An ellipsoid's
  // underside is a staircase of short faces at a different height in every
  // column, which cannot present a plane to anything. It is also the shape.
  v.ellipsoid(0, top - 2.0, front ? -0.3 : -0.6, 2.4, 2.6, 2.4, C.flesh);
  // A hock: one cell of z offset in the lower half, which is all a joint needs
  // at this scale to stop the leg reading as a post.
  if (!front) v.box(-1, 1, -2, 1, 3, -2, C.flesh);
  rimTop(v, C.fleshLt, -2, 2, top - 1, top + 2, -3, 3);
  shadeUnder(v, C.fleshDk, -2, 2, 1, 1, -3, 3);

  // The paw: a pad with three bone claws off the front of it. The claws are the
  // only pale thing down here and they are what make a foot a foot at distance.
  // TWO cells deep with a dark pad row behind them: at one cell each they were
  // three isolated pale cubes on a dark pad, and seen past the belly against
  // ground shadow they read as crumbs floating beside the foot.
  v.box(-1, 0, -1, 1, 0, 2, C.flesh);
  v.box(-1, 0, 2, 1, 0, 2, C.fleshDp);
  // A solid base with only the tips split. Three separate 1x1x2 fingers with a
  // cell of gap between them read as loose cubes from behind and below, against
  // ground shadow — which is most of what the rear capture had round the feet.
  v.box(-1, 0, 3, 1, 0, 3, C.boneDk);
  for (const x of [-1, 0, 1]) v.set(x, 0, 4, C.bone);
  v.set(0, 0, 4, C.boneLt);
  // The heel is the full width of the pad, not one cell of it: a lone cell
  // hanging off the back of a foot reads as a chip that fell off.
  v.box(-1, 0, -2, 1, 0, -2, C.fleshDp); // heel, in its own shadow

  // A bone plate on the outboard face, and the cloth wrap over the ankle. The
  // bone runs THROUGH the wrap's rows — see the note on wrap().
  v.box(dir, 5, -1, dir, 7, 0, C.bone);
  v.set(dir, 7, -1, C.boneLt);
  wrap(v, 1, 1, 1, 2);

  const m = v.build(S, true);
  // -LEG_Y, not the leg's own height. `build()` zeroes the mesh on its lowest
  // cell, so subtracting the hip's height puts the PAW on the ground whatever
  // the leg is made of — a front leg and a back leg are different lengths here
  // and deriving the offset from each one's own row count planted one of them
  // seven centimetres underground.
  m.position.y = -LEG_Y;
  return m;
}

/**
 * One tail vertebra: a bone block, tapering along the chain. `i` is its index,
 * and the taper is the whole reason the tail reads as a tail rather than as
 * three identical bricks in a row.
 */
function buildTailSeg(i: number): THREE.Mesh {
  const v = new VoxelModel();
  const w = i === 0 ? 2 : i < 3 ? 1 : 0; // four segments, tapering in two steps
  // NO TWO LINKS IN THIS CHAIN ARE THE SAME SHAPE, and that is a rendering
  // decision rather than a styling one. Five near-identical blocks laid end to
  // end along one axis agree on their side walls, on their end caps and on
  // their top and bottom planes, and a parting applied at the JOINT between two
  // of them is inherited by the child and cancels down the line — so the pair
  // the seam guard reports simply moves one link along, however many times it
  // is fixed. Every axis is staggered instead: the tip is a cell narrower, a
  // cell shorter and a row lower than the rest, the cross-section is barrelled
  // (narrow, wide, narrow) so neither the top nor the underside is a single
  // plane, and each mesh sits a fraction of a cell further back inside its own
  // link. It is also the shape — a vertebra has a ridge, and it is not a brick.
  // FOUR links, not five, and no two neighbours share a width, a length or a
  // row count. With five there were not enough distinct shapes to go round:
  // three widths and three lengths across five links always leaves one pair
  // identical, and an identical pair meeting end to end shares its undersides
  // whatever is done at the joint. Four links still reads as a segmented tail.
  const len = 4 - i;
  // ALTERNATE links carry the third row. Three widths across five links means
  // two neighbours always share one, and once the tail was flattened to carry
  // out behind rather than curling up, a shared width on two near-colinear
  // links is a shared side wall again. Height is the axis with a spare degree
  // of freedom, so it takes the difference.
  const n = Math.max(w - 1, 0);
  v.box(-n, 0, -len, n, 0, 0, C.bone);
  v.box(-w, 1, -len, w, 1, 0, C.bone);
  if (w > 0 && i % 2 === 0) v.box(-n, 2, -len, n, 2, 0, C.bone);
  // TWO tones and no more. rimTop, shadeUnder, a knuckle every other cell and
  // the barrelled cross-section put five values on a block five cells wide, and
  // the side capture came back with a literal alternating light/dark grid down
  // the whole tail — the same chequer the skull's own note is about, landed
  // somewhere else. One lit ridge and one knuckle per vertebra is what a chain
  // this size can carry.
  rimTop(v, C.boneLt, -w, w, 1, 2, -len, 0);
  v.box(-w, 1, -len, w, 1, -len, C.boneDp);
  // Wraps on the first and the third vertebra, two rows each — on the root alone
  // it was one recoloured row and it appeared in no capture at all. Painted ONTO
  // the vertebra's own cells rather than stamped as a ring around it: wrap()
  // draws a closed band, and a band whose radius reaches past the block it is
  // tied to leaves cells joined to nothing, which bakes as a floating hoop.
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
  // The per-link stagger — see the note at the top of this function.
  m.position.z = -(2.5 + i * 0.2) * S;
  m.position.y = i * 0.17 * S;
  // x as well as y and z: the chain yaws link-by-link in the animator, and a
  // yaw difference only separates two side walls while it is non-zero — at the
  // top of the sway it passes through zero and they are parallel again.
  m.position.x = i * 0.13 * S;
  return m;
}

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------
function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;
  body.add(buildTorso());

  // -- head: parted in z from the barrel it grows out of. The skull's back wall
  // and the shoulder mass's front wall both sit on the barrel's own grid.
  const head = new THREE.Group();
  // ONE step of parting in x, not two. An x parting is signed one way for a
  // part that has two sides, so it is spent as visible asymmetry: at two steps
  // — 0.6 of a cell — the game capture showed the skull sitting off the
  // centreline of the shroud behind it, which is a defect bought to satisfy a
  // tool. One step is 21 mm on a head 630 wide, and it is still enough to keep
  // the ear plate's wall off the shoulder's, which is the pair that meets.
  head.position.set(JOINT_PART, HEAD_Y, HEAD_Z + JOINT_PART);
  head.rotation.x = HEAD_PITCH;
  head.add(buildSkull());
  body.add(head);
  parts.head = head;

  const jaw = new THREE.Group();
  // Parted in x AND z: the mandible is the same width as the muzzle above it and
  // the same depth as the cranium behind it, and it SWINGS, so it sweeps through
  // both planes over the course of a howl.
  jaw.position.set(JOINT_PART, -2 * S, -JOINT_PART);
  jaw.add(buildJaw());
  head.add(jaw);
  parts.jaw = jaw;

  // -- tail: three segments, each hung off the last, curling up over the rump.
  let hook: THREE.Object3D = body;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Group();
    // The parting ACCUMULATES down the chain rather than alternating. Signed the
    // other way it cancels its parent's and the pair simply moves one link on,
    // which is measured behaviour and not a guess.
    // Parted in x at the root, and the whole chain inherits it: a vertebra is
    // the same width as the barrel's own cell columns and rides directly behind
    // them, so their side walls agree until something moves them apart.
    // Parted in x at the root and in y at every link after it, and the whole
    // chain inherits both. A vertebra is the same width as the barrel's own cell
    // columns and rides directly behind them, so their side walls agree; two
    // consecutive vertebrae are the same HEIGHT and meet end to end, so their
    // top and bottom walls agree. Both were reported.
    // Parted in x at the root, in y at every link, and ALTERNATING in x down the
    // chain: two consecutive vertebrae of the same width agree on their side
    // walls, and a y parting does nothing about an x-facing pair. Alternating
    // puts two full steps between any two neighbours.
    // Parted in x at the root, in y at every link, and ALTERNATING in both x
    // and z down the chain. Two consecutive vertebrae are the same shape and
    // meet end to end, so they agree on their side walls AND on the faces where
    // they join; a parting that is not alternated is inherited by the child and
    // cancels, which is how a five-link tail can report pairs at three of its
    // four joints. Alternating puts two full steps between any two neighbours.
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

  // -- legs, hung off the ROOT rather than the body, so the barrel can settle
  // and squash on a footfall without dragging the feet off the ground with it.
  // That is the roster's standing arrangement for a quadruped; see boulderpup.
  const mkLeg = (name: string, front: boolean, x: number, z: number): void => {
    const g = new THREE.Group();
    const dir = Math.sign(x);
    // The FRONT pair takes two steps of parting, the back pair one. This animal
    // carries its skull down between its forelegs, so the cheekbone's outer wall
    // and the foreleg's outer wall are within a cell of each other for the whole
    // idle — one step left them three millimetres apart, which is inside
    // test-zfight's margin and would be inside a depth buffer's too.
    g.position.set(x + dir * JOINT_PART * (front ? 2 : 1), LEG_Y, z);
    g.add(buildLeg(front, dir));
    root.add(g);
    parts[name] = g;
  };
  // The front pair stands OUTBOARD of the cheek spurs, and the back pair takes
  // one step of parting where the front takes two, so the two legs on a side do
  // not agree either. Three things meet here — a spur, a foreleg and the
  // barrel's own flank, which SCALES: the gait squashes the body by up to 3%,
  // and that sweeps the torso's walls across a third of a cell every footfall.
  // A static clearance has to be wider than that sweep.
  // The legs stand well INBOARD of the flanks — the barrel is 0.39 to the hide
  // and 0.46 to the ribs, and the forefeet are at 0.135. That is narrower than
  // the reference's stance and it is the one number on this rig that was chosen
  // by the seam guard rather than by the eye.
  //
  // A foreleg has to clear four things at once: the hide, the ribs, the hind
  // leg on its side, and the skull's ear plate — this animal carries its head
  // down BETWEEN its forelegs, so that last one is unavoidable — and the barrel
  // SCALES with the gait's squash, so two of the four are moving targets. The
  // skull's own clearance is bought with an x parting, and an x parting is
  // signed one way for a part with two sides, which halves the room again.
  // 0.135 and 0.30 came out of sweeping both values and reading the guard;
  // every wider foreleg placement tried put one wall or another inside a
  // millimetre of something. Widening the stance means widening the SKULL's
  // clearance first, which means a narrower cranium — and that is a change to
  // the face, which is the part of this animal that took the longest to make
  // read. It is left as it is, and written down rather than buried.
  mkLeg('legFR', true, 0.135, 0.40);
  mkLeg('legFL', true, -0.135, 0.40);
  // The back pair stands WIDER than the front, which is a heavy quadruped's own
  // stance and is also load-bearing here: at 0.24 the two legs on a side landed
  // a millimetre apart in x once their partings were applied, so the near hind
  // leg's outer wall and the near foreleg's were the same plane every frame.
  mkLeg('legBR', false, 0.28, -0.42);
  mkLeg('legBL', false, -0.28, -0.42);

  // 1.15 and 0.50, measured off the built rig: the model stands 1.40 to the tip
  // of the horn and 0.48 to the widest rib, and `height` is what the framework
  // aims at and floats in water — the horn is not the animal's body.
  return { root, parts, height: 1.15, radius: 0.50 };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

/**
 * Integrated cycle slots — see BeastAnimCtx.cycle(). Two: the gait, whose rate
 * scales with moveSpeed, and the tail sway, which runs at its own rate against
 * it. Anything with a CONSTANT frequency — the idle breath, the ear flick —
 * reads the free clock instead, which is what that clock is for.
 */
const GAIT = 0;
const TAIL = 1;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  // ---- idle: a heavy animal standing still, breathing slowly ----
  let bodyY = BODY_Y + Math.sin(t * 1.3) * 0.008;
  let bodyZ = 0;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = 0;
  let sq = 1;
  let headRX = HEAD_PITCH + Math.sin(t * 1.3 + 0.7) * 0.03;
  let headRY = Math.sin(t * 0.37) * 0.26; // slow, dead-eyed scan of the field
  let headRZ = Math.sin(t * 0.53) * 0.05;
  let headY = HEAD_Y;
  let jawOpen = 0.05 + Math.sin(t * 1.3) * 0.02;
  // The gait pose, as four hip angles. Diagonal pairs on a heavy animal: the
  // front-right and back-left leave the ground together, which is a trot, and it
  // is what stops a four-legged walk looking like a pantomime horse.
  let hipFR = 0;
  let hipFL = 0;
  let hipBR = 0;
  let hipBL = 0;
  let tail1 = TAIL_UP + Math.sin(t * 0.9) * 0.05;
  // The per-link baseline is SMALL because it accumulates: five links at 0.18
  // each is nearly a right angle by the tip, and the tail stood up the middle
  // of the rump as a crest that read as a second horn from behind. 0.08 leaves
  // the chain carrying out behind with a curve in it.
  let tail2 = 0.08 + Math.sin(t * 0.9 - 0.5) * 0.07;
  let tail3 = 0.08 + Math.sin(t * 0.9 - 1.0) * 0.09;
  let tailRY = Math.sin(t * 0.7) * 0.12;

  switch (ctx.action) {
    case 'walk':
    case 'run':
    case 'swim':
    case 'fly': {
      const k = 0.5 + 0.5 * ctx.moveSpeed;
      // 5.0 rad/s at a walk to 9.0 flat out. A beast this heavy does not
      // scurry: the low end is deliberately slower than the fox's.
      const w = ctx.cycle(GAIT, 5.0 + 4.0 * ctx.moveSpeed);
      const a = Math.sin(w);
      const b = Math.sin(w + Math.PI);
      hipFR = a * (0.62 * k);
      hipBL = a * (0.56 * k);
      hipFL = b * (0.62 * k);
      hipBR = b * (0.56 * k);
      // The footfall. `impact` spikes at each contact rather than easing, which
      // is what gives a heavy animal its weight: the barrel drops onto the leg
      // and squashes, instead of floating over the top of the cycle.
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
      // A lunge and a bite: coil back onto the haunches, drive forward, snap.
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
      // The howl. Head thrown up and back, jaw wide, the whole barrel drawing
      // breath it does not need — the one moment this animal stops looking at
      // the ground, which is what makes it read.
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
      // Barrow tide: the beast plants its forelegs, hauls its shoulders up and
      // drags the cold up out of the ground with it. Held, then let down.
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
      hipFR = -1.15 * amp; // forelegs off the ground and pawing
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
      // Bone on bone: the plates jolt against each other and settle. Higher
      // frequency and lower amplitude than a flesh recoil, which is the note the
      // Graveborn's hurt carries too — this thing has no give in it.
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
      tail1 = TAIL_UP - 0.30 * d; // the tail clamps down
      tailRY = Math.sin(at * 30) * 0.14 * d;
      break;
    }
    case 'happy': {
      // It cannot wag what it does not have, so the delight is a stiff-legged
      // bounce and a tail that swings from the root — a dog made of gateposts.
      const hop = Math.abs(Math.sin(at * 5.6));
      bodyY = BODY_Y + hop * 0.10;
      sq = 1 + Math.sin(at * 11.2) * 0.05;
      bodyRY = Math.sin(at * 2.8) * 0.30;
      bodyRZ = Math.sin(at * 5.6) * 0.06;
      headRX = HEAD_PITCH - 0.30;
      headRZ = Math.sin(at * 5.6) * 0.16;
      headRY = Math.sin(at * 2.8) * 0.22;
      headY = HEAD_Y + hop * 0.03;
      jawOpen = 0.32 + Math.sin(at * 11.2) * 0.16; // a dry, clattering pant
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

  // ---- apply ----
  const bodyG = p.body;
  bodyG.position.set(0, bodyY, bodyZ);
  bodyG.rotation.set(bodyRX, bodyRY, bodyRZ);
  // Squash is volume-preserving, but only a QUARTER of it goes sideways. At 0.6
  // the barrel's flanks swept a third of a cell outward on every footfall, and
  // a wall that moves that far crosses whatever the legs and ribs were cleared
  // against — the seam guard reported pairs that only exist mid-stride. A heavy
  // animal squashes downward anyway; the spread is a garnish.
  const xz = 1 + (1 - sq) * 0.25;
  bodyG.scale.set(xz, sq, xz);

  p.head.position.y = headY;
  p.head.rotation.set(headRX, headRY, headRZ);
  p.jaw.rotation.x = jawOpen;

  p.legFR.rotation.x = hipFR;
  p.legFL.rotation.x = hipFL;
  p.legBR.rotation.x = hipBR;
  p.legBL.rotation.x = hipBL;

  // Four links off three authored angles: the wave is a shape, not four
  // independent numbers, and interpolating the tip's share down the chain keeps
  // it that way however many vertebrae the model grows.
  p.tail1.rotation.set(tail1, tailRY, 0);
  p.tail2.rotation.set(tail2, tailRY * 0.75, 0);
  p.tail3.rotation.set(tail3, tailRY * 0.5, 0);
  p.tail4.rotation.set(tail3, tailRY * 0.3, 0);
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: BeastSpecies = {
  id: 'graveback',
  nameKey: 'beast.graveback.name',
  element: 'shadow',
  locomotion: 'ground',
  descriptionKey: 'beast.graveback.desc',
  // A wall. It hits hard and it is very hard to move, and it is slow enough
  // that the player has to want that trade — the Graveborn is the fast half of
  // this pair and this is the half you put in front.
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
