import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// ---------------------------------------------------------------------------
// Drakelet — a proud pocket dragon in ember-crimson scale mail. The showpiece:
// two-segment bat wings with membrane, chest that puffs before a breath attack,
// three-segment whip tail with an arrow tip, horns, spikes, the works.
// ---------------------------------------------------------------------------

const S = 0.1; // voxel scale

// Palette warmed off raspberry. The old 0xe04f68 / 0xa32f4a / 0xff8496 set was a
// cool magenta-red: under this game's warm 0xfff2d9 sun it read as a cool pink
// against every other warm-lit thing in frame, and next to the fox's orange and the
// pup's basalt it looked like it came from a different game. Rotating the hue about
// 12 degrees toward orange keeps it unmistakably crimson and puts it back in the
// roster's palette.
const C = {
  scale: 0xd94a44,      // ember-crimson
  scaleDk: 0x9a2c2c,
  scaleLt: 0xff8168,    // sunlit crest along back, skull and haunches
  belly: 0xf9e6c6,
  bellyDk: 0xdcb589,
  horn: 0xfff3e0,
  claw: 0xfff3e0,
  spike: 0x7d2422,
  // Membrane lifted two full steps. The old 0x7a1f2e / 0x5c1723 pair sat at ~15%
  // luminance, so in every portrait the wings were black slivers and the pale
  // arm bone read as a loose stick floating beside the dragon.
  membrane: 0xb8443c,
  membraneDk: 0x8a2f2b, // trailing edge, one step down for chord definition
  membraneLt: 0xd06052, // sunlit inner panel
  wingBone: 0xe3c288,   // bone leading-edge strip. Pulled down from 0xf6dcae:
  // as the palest thing on the model, run across the full span at two rows tall,
  // it became a bright bar that out-read the membrane it was supposed to support.
  // Dark iris, bright catchlight — the polarity every species in the roster now
  // shares. A pale gold 2x3 iris on this cream face plate merged straight into it and
  // left only the pupil column reading, which a critic saw as "wide black eye slots".
  iris: 0x38131a,       // dark ember-crimson: the coat hue at a fifth of its value
  eyeShine: 0xfff6dd,   // catchlight, matching the dragon's fire
  eyeLid: 0x8a2320,     // socket rim: scale at half value
  nostril: 0x6b1f1c,
} as const;

// Base pose constants shared between buildRig() and animate()
const BODY_Y = 0.52;
/** Hover height PalActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'drakelet.fang-rush',
    name: 'Fang Rush',
    description: 'Darts in with a snap of needle fangs and far too much confidence for its size.',
    element: 'dragon',
    targeting: 'melee',
    cost: 5,
    cooldown: 1.5,
    power: 13,
    range: 2.5,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'drakelet.drakefire-breath',
    name: 'Drakefire Breath',
    description: 'Puffs up its chest, inhales the whole sky, and exhales a rolling cone of ember-red dragonfire.',
    element: 'dragon',
    targeting: 'beam',
    cost: 15,
    cooldown: 6,
    power: 26,
    range: 11,
    learnAtLevel: 5,
    castAnim: 'cast',
  },
  {
    id: 'drakelet.tailspin-tempest',
    name: 'Tailspin Tempest',
    description: 'Whirls its arrow-tipped tail into a shredding cyclone that batters everything in reach.',
    element: 'dragon',
    targeting: 'aoe',
    cost: 18,
    cooldown: 8,
    power: 30,
    range: 5,
    storePrice: 260,
    castAnim: 'special',
  },
  {
    id: 'drakelet.comet-crash',
    name: 'Comet Crash',
    description: 'Climbs, tucks its wings, and falls like a burning star. The landing is not subtle.',
    element: 'dragon',
    targeting: 'projectile',
    cost: 24,
    cooldown: 11.5,
    power: 44,
    range: 20,
    storePrice: 390,
    castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------

/**
 * Inner wing segment: shoulder-to-elbow arm bone with the membrane hung off it.
 *
 * The old version put the bone at y=1 and the membrane at y=0 — diagonally
 * adjacent, so the two masses shared no face and the wing photographed as two
 * unrelated sticks. Everything now lives on one plane at y=0 and is fully
 * face-connected, with a second bone row at y=1 purely so the leading edge has
 * thickness and the wing does not disappear when seen edge-on.
 */
function buildWingInner(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  for (let i = 0; i < 4; i++) {
    v.set(cell(i), 0, 1, C.wingBone); // arm bone, in-plane with the membrane
    if (i < 2) v.set(cell(i), 1, 1, C.wingBone); // thickness at the shoulder only
    v.set(cell(i), 0, 0, C.membraneLt);
    v.set(cell(i), 0, -1, C.membrane);
    v.set(cell(i), 0, -2, i < 3 ? C.membrane : C.membraneDk);
    if (i < 3) v.set(cell(i), 0, -3, C.membraneDk); // trailing edge
    // A shaded row UNDER the forward half of the panel. Without it the inner wing is
    // a one-cell sheet, so whichever wing happens to face the camera edge-on shows
    // nothing but the pale bone strip — which is precisely why a critic saw one big
    // red wing on the right and "a mismatched tan sliver" on the left.
    v.set(cell(i), -1, 1, C.membraneDk);
    v.set(cell(i), -1, 0, C.membraneDk);
  }
  v.set(cell(3), 2, 1, C.wingBone); // elbow knuckle
  const m = v.build(S, false);
  m.position.set(0, -0.15, -0.02);
  return m;
}

/** Outer wing segment: hand, radiating finger ribs, scalloped membrane fan. */
function buildWingOuter(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  const depth = [4, 5, 6, 6, 5, 3]; // membrane chord per column, scalloped tip.
  // Deepened from [2,3,4,5,4,3]: a hand-wing barely two cells deep at the root
  // left a gap between the inner panel and the fan, which is what turned the
  // whole wing into confetti at portrait range.
  for (let i = 0; i < 6; i++) {
    v.set(cell(i), 0, 1, C.wingBone); // pale leading-edge strip
    if (i < 2) v.set(cell(i), 1, 1, C.wingBone); // thickened at the wrist only
    v.set(cell(i), -1, 1, C.membraneDk); // leading-edge underside: see buildWingInner
    for (let z = 0; z >= -depth[i]; z--) {
      const trailing = z === -depth[i];
      v.set(cell(i), 0, z, trailing ? C.membraneDk : z > -2 ? C.membraneLt : C.membrane);
    }
  }
  // Two finger bones, each a CONTINUOUS dark line running root-to-tip down its own
  // column. The previous version dropped two dark cells per column at positions
  // derived from round(i * 0.7) and round(i * 1.3), which staggered them into a
  // pink-on-red chequerboard — it photographed as a missing-texture checker, not as
  // membrane structure. A rib has to follow the bone or it is just noise.
  for (const i of [2, 4]) {
    for (let z = 0; z >= -depth[i]; z--) v.set(cell(i), 0, z, C.scaleDk);
  }
  v.set(cell(5), 1, 1, C.claw); // little wing thumb-claw
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildLeg(): THREE.Mesh {
  const v = new VoxelModel();
  v.ellipsoid(0, 1.6, -0.2, 1.5, 1.5, 1.6, C.scale); // haunch
  v.box(-1, 0, -1, 0, 0, 1, C.scale); // foot
  v.set(-1, 0, 2, C.claw); // toe claws
  v.set(0, 0, 2, C.claw);
  const m = v.build(S);
  m.position.y = -0.30;
  return m;
}

function buildArm(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-1, 1, -1, 0, 2, 0, C.scale); // stubby upper arm
  v.box(-1, 0, 0, 0, 0, 1, C.scale); // paw reaching forward
  v.set(-1, 0, 2, C.claw);
  v.set(0, 0, 2, C.claw);
  const m = v.build(S);
  m.position.y = -0.26;
  return m;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;

  // -- torso: plump scaled barrel with a spiked spine and haunches --
  const torsoVox = new VoxelModel();
  torsoVox.ellipsoid(0, 3.6, -0.5, 3.2, 3.6, 4.4, C.scale);
  torsoVox.ellipsoid(2.5, 2.4, -2.2, 1.5, 1.9, 1.9, C.scale);   // haunches
  torsoVox.ellipsoid(-2.5, 2.4, -2.2, 1.5, 1.9, 1.9, C.scale);
  torsoVox.ellipsoid(0, 5.4, -0.5, 2.4, 1.8, 3.6, C.scaleLt);   // sunlit back sheen
  // Underside in shadow. The old torso was one flat rose from crown to belly, so
  // the barrel had no volume and the haunches vanished into it.
  shadeUnder(torsoVox, C.scaleDk, -4, 4, 0, 5, -5, 5);
  // dorsal spike ridge
  torsoVox.set(0, 6, 2, C.spike);
  torsoVox.set(0, 7, 2, C.spike);
  torsoVox.set(0, 6, 0, C.spike);
  torsoVox.set(0, 7, 0, C.spike);
  torsoVox.set(0, 8, 0, C.spike);
  torsoVox.set(0, 6, -2, C.spike);
  torsoVox.set(0, 7, -2, C.spike);
  torsoVox.set(0, 6, -4, C.spike);
  const torso = torsoVox.build(S);
  torso.position.y = -0.40;
  body.add(torso);

  // -- chest: cream belly plates on their own pivot so it can puff --
  const chest = new THREE.Group();
  chest.position.set(0, -0.06, 0.16);
  body.add(chest);
  parts.chest = chest;

  const chestVox = new VoxelModel();
  // Narrowed from 2.4 x 3.0: a full-width cream barrel swallowed the rose scale
  // entirely, so the dragon read as a cream blob wearing red patches.
  chestVox.ellipsoid(0, 2.8, 1.4, 1.9, 2.5, 2.3, C.belly);
  chestVox.ellipsoid(0, 4.0, 1.5, 1.95, 0.5, 2.35, C.bellyDk); // plate seams
  chestVox.ellipsoid(0, 2.5, 1.5, 1.95, 0.5, 2.35, C.bellyDk);
  chestVox.ellipsoid(0, 1.2, 1.5, 1.8, 0.5, 2.2, C.bellyDk);
  shadeUnder(chestVox, C.bellyDk, -2, 2, 0, 3, -1, 4);
  const chestMesh = chestVox.build(S);
  chestMesh.position.set(0, -0.32, 0.02);
  chest.add(chestMesh);

  // -- head: big cranium, cream muzzle, horns, brows, gold-lit eyes --
  const head = new THREE.Group();
  head.position.set(0, 0.24, 0.30);
  body.add(head);
  parts.head = head;

  // Strictly three materials on the skull — scale, cream horn and one dark.
  // The old red mask + gold iris + sheen bridge + brow ridge collided into
  // mush at portrait range.
  const headVox = new VoxelModel();
  headVox.ellipsoid(0, 2.8, -0.2, 3.4, 2.7, 3.0, C.scale);      // cranium
  // Muzzle: a STEPPED wedge, not a cantilevered brick. Three z steps, each one
  // narrower and shorter than the last, and the value falls as it goes down —
  // cream only on the top and front rows, mid cream in the middle, and the jaw line
  // underneath in dark scale so the pale block visibly sits on something. The old
  // muzzle was a single pale ellipsoid poking straight out of the face with nothing
  // beneath it, which is the classic bar-of-soap read.
  // Starts at z=4, clear of the brow plate at z=3 — the plate is painted after this
  // and would otherwise erase the snout's whole first step. It also tops out at y=2,
  // two rows BELOW the eye line: a taller snout stands proud of the face plate
  // directly in front of the eyes and hides them completely, which is exactly what a
  // first attempt at this did.
  const snout: Array<[number, number, number, number]> = [
    // [z, half-width, y0, y1]
    [4, 1, 0, 2],
    [5, 1, 1, 2],
    [6, 0, 2, 2],
  ];
  for (const [z, hw, y0, y1] of snout) {
    for (let x = -hw; x <= hw; x++) {
      for (let y = y0; y <= y1; y++) {
        headVox.set(x, y, z, y === y1 ? C.belly : y === y0 ? C.scaleDk : C.bellyDk);
      }
    }
  }
  headVox.set(-1, 2, 5, C.nostril);                              // nostrils, on top
  headVox.set(1, 2, 5, C.nostril);                               // of the snout
  // Brow plate runs up to row 5 so the three-row eye has a face to sit in.
  headVox.box(-3, 2, 3, 3, 5, 3, C.scale);
  rimTop(headVox, C.scaleLt, -3, 3, 0, 6, -3, 4);
  shadeUnder(headVox, C.scaleDk, -3, 3, 0, 3, -3, 2);
  // inner: 1, not 2. On this wide skull the outer eye column at |x| = 3 is the very
  // edge of the head, so the gold iris was half-hidden round the curve and only the
  // two-cell pupil showed: two black vertical voids with nothing to explain them.
  // Brought inboard, iris and pupil are both fully presented to the camera.
  // A pale MASK across the eye rows before the eyes go in. A dark crimson iris on a
  // crimson brow plate has no boundary once the face is in shade — the real-game
  // portrait came back with only the catchlights visible, two pale squares floating on
  // red. Cream around the socket is what makes the dark iris an eye. It also ties the
  // brow to the cream snout below it, so the head reads as one shape.
  for (let x = -3; x <= 3; x++) {
    headVox.set(x, 3, 3, C.bellyDk);
    headVox.set(x, 4, 3, C.belly);
  }
  eyes2x2(headVox, {
    inner: 1, y: 3, faceZ: 3, iris: C.iris, shine: C.eyeShine,
    lid: C.eyeLid, browProud: true, bridge: C.belly,
  });
  // Horns: two columns per side, swept back and stepped. The base course now starts
  // at y = 3 / z = +1 — INSIDE the cranium — and climbs aft in a solid staircase with
  // no diagonal-only joins. The previous version rooted at y = 4 / z = -1, whose
  // lower cells were only just inside the skull's curve; from a three-quarter bearing
  // sky showed between horn and crown and a critic logged them as hovering.
  for (const sx of [1, -1]) {
    for (const w of [2, 3]) {
      const step: Array<[number, number]> = [
        [3, 1], [3, 0], [4, 0], [4, -1], [5, -1], [5, -2], [6, -2], [6, -3], [7, -3],
      ];
      for (const [y, z] of step) headVox.set(sx * w, y, z, C.horn);
    }
  }
  const headMesh = headVox.build(S);
  // +0.05z compensates the extra snout step: build() re-centres on the bounding box,
  // so growing the model forward slides the cranium back into the chest.
  headMesh.position.set(0, -0.30, 0.05);
  head.add(headMesh);

  // -- lower jaw on a hinge --
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, 0.10);
  head.add(jaw);
  parts.jaw = jaw;

  const jawVox = new VoxelModel();
  // Dark scale, not cream. This is the volume UNDER the pale muzzle; painting it
  // cream too made the whole lower face one pale slab with no chin line in it.
  jawVox.box(-1, 0, 0, 1, 0, 3, C.scaleDk);
  jawVox.set(0, 0, 3, C.bellyDk); // one lit cell at the chin point
  // (fang voxels removed — they collided with the muzzle and muddied the face)
  const jawMesh = jawVox.build(S, false);
  jawMesh.position.set(-0.05, -0.05, 0);
  jaw.add(jawMesh);

  // -- wings: shoulder pivot + elbow pivot per side --
  // Shoulders sit low and behind the skull: at y=0.18 the spread wings crossed
  // the horns in every portrait and the head lost its outline.
  const wingR = new THREE.Group();
  // |x| = 0.14 against a torso half-width of 0.32 buries the root column two cells
  // inside the barrel. At the old 0.22 the root sat right on the silhouette edge, and
  // with the shoulder rotated the membrane's first column swung clear of the body —
  // a critic measured a ~40px air gap between wing root and torso in a 1200px shot.
  wingR.position.set(0.14, 0.06, -0.08);
  body.add(wingR);
  parts.wingR = wingR;
  wingR.add(buildWingInner(1));
  const wingTipR = new THREE.Group();
  // 0.34, not 0.38: the inner section ends at 0.40 from its own pivot, so the hand
  // now overlaps the forearm by a cell and the elbow cannot open a seam.
  wingTipR.position.set(0.34, 0.05, 0);
  wingR.add(wingTipR);
  parts.wingTipR = wingTipR;
  wingTipR.add(buildWingOuter(1));

  const wingL = new THREE.Group();
  wingL.position.set(-0.14, 0.06, -0.08);
  body.add(wingL);
  parts.wingL = wingL;
  wingL.add(buildWingInner(-1));
  const wingTipL = new THREE.Group();
  wingTipL.position.set(-0.34, 0.05, 0);
  wingL.add(wingTipL);
  parts.wingTipL = wingTipL;
  wingTipL.add(buildWingOuter(-1));

  // -- legs and stubby arms --
  const legL = new THREE.Group();
  legL.position.set(-0.13, -0.22, -0.06);
  legL.add(buildLeg());
  body.add(legL);
  parts.legL = legL;

  const legR = new THREE.Group();
  legR.position.set(0.13, -0.22, -0.06);
  legR.add(buildLeg());
  body.add(legR);
  parts.legR = legR;

  const armL = new THREE.Group();
  armL.position.set(-0.15, 0.0, 0.18);
  armL.add(buildArm());
  body.add(armL);
  parts.armL = armL;

  const armR = new THREE.Group();
  armR.position.set(0.15, 0.0, 0.18);
  armR.add(buildArm());
  body.add(armR);
  parts.armR = armR;

  // -- three-segment tail ending in an arrowhead --
  const tail1 = new THREE.Group();
  tail1.position.set(0, -0.10, -0.36);
  body.add(tail1);
  parts.tail1 = tail1;

  const t1Vox = new VoxelModel();
  t1Vox.ellipsoid(0, 0, -2, 1.6, 1.6, 2.4, C.scale);
  t1Vox.set(0, 2, -2, C.spike); // tail spike
  const t1Mesh = t1Vox.build(S, false);
  t1Mesh.position.set(-0.05, -0.17, 0);
  tail1.add(t1Mesh);

  const tail2 = new THREE.Group();
  tail2.position.set(0, 0, -0.40);
  tail1.add(tail2);
  parts.tail2 = tail2;

  const t2Vox = new VoxelModel();
  t2Vox.ellipsoid(0, 0, -1.8, 1.1, 1.1, 2.1, C.scale);
  t2Vox.set(0, 1, -2, C.spike);
  const t2Mesh = t2Vox.build(S, false);
  t2Mesh.position.set(-0.05, -0.12, 0);
  tail2.add(t2Mesh);

  const tail3 = new THREE.Group();
  tail3.position.set(0, 0, -0.36);
  tail2.add(tail3);
  parts.tail3 = tail3;

  const t3Vox = new VoxelModel();
  t3Vox.set(0, 0, -1, C.scaleDk); // thin whip
  t3Vox.set(0, 0, -2, C.scaleDk);
  t3Vox.set(0, 0, -3, C.spike);   // arrowhead diamond
  t3Vox.set(0, 0, -4, C.spike);
  t3Vox.set(-1, 0, -3, C.spike);
  t3Vox.set(1, 0, -3, C.spike);
  t3Vox.set(0, 1, -3, C.spike);
  t3Vox.set(0, -1, -3, C.spike);
  t3Vox.set(0, 0, -5, C.spike);   // point
  const t3Mesh = t3Vox.build(S, false);
  t3Mesh.position.set(-0.05, -0.05, 0);
  tail3.add(t3Mesh);

  // Ground contact blob — see contactshadow.ts. A hovering dragon with no shadow
  // beneath it is pasted onto the scenery rather than flying over it.
  const blob = makeContactBlob(0.7, HOVER);
  root.add(blob);
  parts.blob = blob;

  return { root, parts, height: 1.15, radius: 0.45 };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  // ---- default idle pose: perched, wings folded, breathing ----
  let bodyX = 0;
  let bodyZ = 0;
  let bodyY = BODY_Y + Math.sin(t * 2.2) * 0.02;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = Math.sin(t * 1.1) * 0.02;
  let sq = 1;
  let chestS = 1 + Math.sin(t * 2.2) * 0.035; // breathing
  let headRX = Math.sin(t * 0.9) * 0.06 - 0.05;
  let headRY = Math.sin(t * 0.5) * 0.22; // slow proud look-around
  let headRZ = Math.sin(t * 0.7 + 1) * 0.05;
  let jawOpen = 0.06 + Math.sin(t * 2.2) * 0.02;
  // Perched wings furl UP over the shoulders like an umbrella, membrane rolled
  // vertical. The old pose (flap 0.45, wingRX 0) left both membranes horizontal
  // and edge-on, so a perched drakelet grew two pale planks out of its ribs.
  let flap = 1.15 + Math.sin(t * 2.2) * 0.03; // folded, riding the breath
  let sweep = 0.55; // laid back along the flank
  let wingRX = 0.85; // membrane rolled up on edge, the way a bat furls
  let tipFold = 2.0; // hand folded back hard against the arm
  let tipFlap = -0.2;
  let legRX = 0.10;
  let legSplit = 0;
  let armRX = 0.15 + Math.sin(t * 2.2) * 0.05;
  let armSplit = Math.sin(t * 2.2 + 1) * 0.03;
  let tailRX1 = 0.06;
  let tailRX2 = 0.04;
  let tailRX3 = 0.02;
  let tailRY1 = Math.sin(t * 1.4) * 0.18;
  let tailRY2 = Math.sin(t * 1.4 - 0.6) * 0.22;
  let tailRY3 = Math.sin(t * 1.4 - 1.2) * 0.26;

  switch (ctx.action) {
    case 'fly':
    case 'walk':
    case 'run':
    case 'swim': {
      const k = 0.5 + 0.5 * ctx.moveSpeed;
      const w = t * (7.5 + 3.5 * ctx.moveSpeed);
      const raw = Math.sin(w);
      const beat = Math.sign(raw) * Math.abs(raw) ** 0.75; // snappy downstroke
      // Peak flap trimmed from 0.75-1.00 rad to 0.52-0.70. At a full radian the wing
      // plane swung past vertical twice a beat, so a still caught it edge-on as often
      // as broadside — which is how a critic ended up describing one wing as a big red
      // slab and the other as a tan sliver. A shallower beat keeps the membrane
      // presenting its pattern for most of the cycle.
      flap = beat * (0.52 + 0.18 * k);
      sweep = 0.18;
      tipFold = 0.12;
      tipFlap = Math.sin(w - 0.85) * 0.55; // membrane lag / follow-through
      // Standing 0.34 rad of roll on top of the beat's own wobble: with a purely
      // horizontal membrane the wings passed edge-on through the middle of every
      // stroke, and every second frame caught them as two bare leading edges.
      wingRX = 0.34 + Math.sin(w - 0.4) * 0.14;
      bodyY = BODY_Y + Math.sin(w - 1.1) * 0.07 * k + 0.06;
      bodyRX = 0.30 * k + Math.sin(w - 1.3) * 0.06; // pitched into the flight
      bodyRZ = Math.sin(t * 1.6) * 0.08 * k;        // banking drift
      headRX = -0.22 * k + Math.sin(w - 1.5) * 0.04; // gaze stays level
      headRY = Math.sin(t * 0.8) * 0.10;
      jawOpen = 0.05;
      chestS = 1 + Math.sin(w) * 0.02;
      legRX = 0.85; // tucked
      armRX = 0.70; // tucked
      armSplit = 0;
      tailRX1 = 0.12 + Math.sin(w - 1.6) * 0.08;
      tailRX2 = 0.08 + Math.sin(w - 2.1) * 0.10;
      tailRX3 = 0.04 + Math.sin(w - 2.6) * 0.12;
      tailRY1 = Math.sin(t * 1.9) * 0.10;
      tailRY2 = Math.sin(t * 1.9 - 0.5) * 0.13;
      tailRY3 = Math.sin(t * 1.9 - 1.0) * 0.16;
      break;
    }
    case 'attack': {
      const wind = easeOutCubic(clamp01(at / 0.16));
      const lunge = easeOutCubic(clamp01((at - 0.16) / 0.14));
      const rec = easeInOutSine(clamp01((at - 0.34) / 0.36));
      const punch = lunge * (1 - rec);
      const coil = wind * (1 - lunge);
      const snap = easeOutCubic(clamp01((at - 0.26) / 0.08));
      bodyRX = -0.30 * coil + 0.45 * punch;
      bodyZ = -0.08 * coil + 0.22 * punch;
      bodyY = BODY_Y - 0.05 * coil + 0.04 * punch;
      sq = 1 - 0.06 * coil + 0.05 * punch;
      headRX = -0.35 * coil + 0.30 * punch;
      jawOpen = 0.7 * Math.max(coil * 0.7, lunge) * (1 - snap); // bite snaps shut
      flap = 0.6 * coil - 0.35 * punch; // flare, then rake back
      sweep = 0.35 + 0.5 * punch;
      tipFold = 0.25 + 0.4 * punch;
      tipFlap = -0.2 * punch;
      chestS = 1 + 0.05 * coil;
      legRX = 0.3 * punch;
      armRX = -0.4 * punch; // claws thrown forward
      tailRX1 = 0.2 * coil - 0.25 * punch; // counterbalance
      tailRX2 = 0.12 * coil - 0.18 * punch;
      tailRX3 = 0.06 * coil - 0.12 * punch;
      tailRY1 = Math.sin(t * 6) * 0.06;
      tailRY2 = Math.sin(t * 6 - 0.5) * 0.08;
      tailRY3 = Math.sin(t * 6 - 1.0) * 0.10;
      break;
    }
    case 'cast': {
      // The signature move: deep inhale, chest puffs, then the exhale thrust.
      const inhale = easeInOutSine(clamp01(at / 0.45));
      const exhale = easeOutCubic(clamp01((at - 0.45) / 0.25));
      const shiver = Math.sin(t * 24) * 0.05 * inhale;
      chestS = 1 + 0.28 * inhale * (1 - exhale * 0.8);
      bodyRX = -0.35 * inhale * (1 - exhale) + 0.28 * exhale;
      bodyY = BODY_Y + 0.08 * inhale - 0.02 * exhale;
      sq = 1 + 0.05 * inhale * (1 - exhale);
      headRX = -0.45 * inhale * (1 - exhale) + 0.35 * exhale;
      headRY = 0;
      jawOpen = 0.10 * inhale + 0.85 * exhale;
      flap = 0.75 * inhale * (1 - exhale * 0.5) + shiver;
      sweep = 0.35;
      tipFold = 0.25;
      tipFlap = shiver * 2;
      legRX = 0.15 + 0.2 * inhale;
      armRX = 0.3 * inhale - 0.3 * exhale;
      tailRX1 = 0.20 * inhale;
      tailRX2 = 0.14 * inhale;
      tailRX3 = 0.08 * inhale;
      tailRY1 = Math.sin(t * 1.4) * 0.06;
      tailRY2 = Math.sin(t * 1.4 - 0.6) * 0.08;
      tailRY3 = Math.sin(t * 1.4 - 1.2) * 0.10;
      break;
    }
    case 'special': {
      // Rear-up roar: wings blasting, tail whipping, full drama.
      const rise = easeOutCubic(clamp01(at / 0.35));
      const fall = easeInOutSine(clamp01((at - 0.85) / 0.35));
      const amp = rise * (1 - fall);
      bodyRX = -0.55 * amp;
      bodyY = BODY_Y + 0.16 * amp + Math.sin(t * 12) * 0.01;
      sq = 1 + 0.06 * amp;
      chestS = 1 + 0.12 * amp;
      headRX = -0.30 * amp + Math.sin(t * 10) * 0.04 * amp;
      headRY = 0;
      jawOpen = 0.8 * amp; // ROAR
      flap = amp * (0.4 + Math.sin(t * 16) * 0.55);
      sweep = 0.15;
      tipFold = 0.10;
      tipFlap = Math.sin(t * 16 - 0.8) * 0.5 * amp;
      wingRX = Math.sin(t * 16 - 0.4) * 0.08 * amp;
      legRX = 0.5 * amp;
      legSplit = 0.15 * amp;
      armRX = -0.6 * amp; // claws raised skyward
      tailRX1 = 0.15 * amp;
      tailRX2 = 0.10 * amp;
      tailRX3 = 0.05 * amp;
      tailRY1 = Math.sin(at * 9) * 0.50 * amp;
      tailRY2 = Math.sin(at * 9 - 0.7) * 0.60 * amp;
      tailRY3 = Math.sin(at * 9 - 1.4) * 0.70 * amp;
      break;
    }
    case 'hurt': {
      const d = Math.max(0, 1 - at / 0.5);
      bodyX = Math.sin(at * 50) * 0.04 * d;
      bodyRZ = Math.sin(at * 44) * 0.12 * d;
      bodyRX = -0.18 * d; // knocked back
      bodyY = BODY_Y + 0.03 * d;
      headRX = 0.25 * d; // head ducks
      headRZ = Math.sin(at * 40) * 0.08 * d;
      jawOpen = 0.4 * d; // yelp
      flap = 0.7 * d + Math.sin(t * 26) * 0.4 * d; // flailing
      sweep = 0.3 + 0.5 * (1 - d);
      tipFold = 0.3 + 0.8 * (1 - d);
      chestS = 1 - 0.05 * d;
      armRX = 0.5 * d; // curls up
      legRX = 0.3 * d;
      tailRX1 = -0.15 * d; // tail clamps
      tailRX2 = -0.10 * d;
      tailRX3 = -0.06 * d;
      tailRY1 = Math.sin(at * 30) * 0.10 * d;
      tailRY2 = Math.sin(at * 30 - 0.5) * 0.14 * d;
      tailRY3 = Math.sin(at * 30 - 1.0) * 0.18 * d;
      break;
    }
    case 'happy': {
      const hop = Math.abs(Math.sin(at * 6.5));
      bodyY = BODY_Y + hop * 0.16;
      sq = 1 + Math.sin(at * 13) * 0.07; // squash-and-stretch bounce
      bodyRY = Math.sin(at * 3.2) * 0.40;
      bodyRZ = Math.sin(at * 6.5) * 0.08;
      headRX = -0.10;
      headRZ = Math.sin(at * 6.5) * 0.15;
      headRY = Math.sin(at * 3.2) * 0.15;
      jawOpen = 0.35 + Math.sin(at * 13) * 0.10; // delighted panting
      flap = 0.3 + Math.sin(at * 13) * 0.35; // excited flutter
      sweep = 0.5;
      tipFold = 0.4;
      tipFlap = Math.sin(at * 13 - 0.6) * 0.3;
      chestS = 1 + hop * 0.05;
      armRX = -0.3 + Math.sin(at * 13) * 0.20; // paddling paws
      armSplit = Math.sin(at * 13) * 0.1;
      legRX = 0.2 + hop * 0.15;
      tailRX1 = 0.1;
      tailRY1 = Math.sin(at * 11) * 0.45; // furious wag
      tailRY2 = Math.sin(at * 11 - 0.6) * 0.55;
      tailRY3 = Math.sin(at * 11 - 1.2) * 0.65;
      break;
    }
    case 'idle':
    default:
      break;
  }

  // ---- apply ----
  // Contact blob stays flat on the ground and widens a little with the wingspan.
  updateContactBlob(p.blob, rig.root, 1 + 0.25 * clamp01(1 - Math.abs(sweep)));

  const body = p.body;
  body.position.set(bodyX, bodyY, bodyZ);
  body.rotation.set(bodyRX, bodyRY, bodyRZ);
  const xz = 1 + (1 - sq) * 0.55;
  body.scale.set(xz, sq, xz);

  p.chest.scale.setScalar(chestS);
  p.head.rotation.set(headRX, headRY, headRZ);
  p.jaw.rotation.x = jawOpen;

  p.wingR.rotation.set(wingRX, sweep, flap);
  p.wingL.rotation.set(wingRX, -sweep, -flap);
  p.wingTipR.rotation.set(0, tipFold, tipFlap);
  p.wingTipL.rotation.set(0, -tipFold, -tipFlap);

  p.legL.rotation.set(legRX, 0, -legSplit);
  p.legR.rotation.set(legRX, 0, legSplit);
  p.armL.rotation.x = armRX + armSplit;
  p.armR.rotation.x = armRX - armSplit;

  p.tail1.rotation.set(tailRX1, tailRY1, 0);
  p.tail2.rotation.set(tailRX2, tailRY2, 0);
  p.tail3.rotation.set(tailRX3, tailRY3, 0);
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'drakelet',
  name: 'Drakelet',
  element: 'dragon',
  locomotion: 'flying',
  description:
    'A pocket-sized dragon with the ego of a mountain-sized one. Polishes its '
    + 'ember-crimson scales on cliff quartz and practices its roar at sunrise, every sunrise.',
  baseStats: { maxHp: 46, attack: 13, defense: 9, speed: 5.6 },
  skills: [
    'drakelet.fang-rush',
    'drakelet.drakefire-breath',
    'drakelet.tailspin-tempest',
    'drakelet.comet-crash',
  ],
  buildRig,
  animate,
};
