import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Drakelet — a proud pocket dragon in rose-crimson scale mail. The showpiece:
// two-segment bat wings with membrane, chest that puffs before a breath attack,
// three-segment whip tail with an arrow tip, horns, spikes, the works.
// ---------------------------------------------------------------------------

const S = 0.1; // voxel scale

const C = {
  scale: 0xd8465f,      // rose-crimson
  scaleDk: 0x9e2c47,
  scaleLt: 0xef6f82,
  belly: 0xf6e0bd,
  bellyDk: 0xdcc094,
  horn: 0xf2e9d5,
  claw: 0xf2e9d5,
  spike: 0x8a2340,
  membrane: 0x7a1f2e,   // dark wine membrane — separates wing from body in flight
  membraneDk: 0x5c1723, // deeper trailing edge
  wingBone: 0xdcc094,   // pale bone leading-edge strip
  eye: 0x2a1430,
  eyeShine: 0xffffff,
  iris: 0xffc45e,
  nostril: 0x6e1d33,
  tooth: 0xffffff,
} as const;

// Base pose constants shared between buildRig() and animate()
const BODY_Y = 0.52;

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
    description: 'Puffs up its chest, inhales the whole sky, and exhales a rolling cone of rose-pink dragonfire.',
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

/** Inner wing segment: shoulder-to-elbow arm bone with a small membrane wedge. */
function buildWingInner(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  for (let i = 0; i < 4; i++) {
    v.set(cell(i), 1, 0, C.wingBone); // pale arm-bone leading edge
    v.set(cell(i), 0, -1, C.membrane); // membrane wedge toward the body
    if (i < 3) v.set(cell(i), 0, -2, C.membraneDk);
  }
  v.set(cell(3), 2, 0, C.wingBone); // elbow knuckle
  const m = v.build(S, false);
  m.position.set(0, -0.15, -0.02);
  return m;
}

/** Outer wing segment: hand, radiating finger ribs, scalloped membrane fan. */
function buildWingOuter(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  const depth = [2, 3, 4, 5, 4, 3]; // membrane chord per column, scalloped tip
  for (let i = 0; i < 6; i++) {
    v.set(cell(i), 0, 0, C.wingBone); // pale leading-edge strip
    for (let z = -1; z >= -depth[i]; z--) {
      const trailing = z === -depth[i];
      v.set(cell(i), 0, z, trailing ? C.membraneDk : C.membrane);
    }
  }
  // radiating finger ribs across the membrane
  for (let i = 1; i < 6; i++) {
    const r1 = -Math.min(Math.round(i * 0.4), depth[i] - 1);
    const r2 = -Math.min(Math.round(i * 0.8), depth[i] - 1);
    if (r1 < 0) v.set(cell(i), 0, r1, C.scaleDk);
    if (r2 < r1) v.set(cell(i), 0, r2, C.scaleDk);
  }
  v.set(cell(5), 1, 0, C.claw); // little wing thumb-claw
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
  chestVox.ellipsoid(0, 3, 1.2, 2.4, 3.0, 2.6, C.belly);
  chestVox.ellipsoid(0, 4.4, 1.3, 2.45, 0.5, 2.65, C.bellyDk); // plate seams
  chestVox.ellipsoid(0, 2.8, 1.3, 2.45, 0.5, 2.65, C.bellyDk);
  chestVox.ellipsoid(0, 1.4, 1.3, 2.3, 0.5, 2.5, C.bellyDk);
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
  headVox.ellipsoid(0, 2.2, 2.8, 1.9, 1.3, 2.0, C.scale);       // muzzle
  headVox.set(-1, 2, 4, C.eye);                                  // nostrils
  headVox.set(1, 2, 4, C.eye);
  // Eyes: 2x2 cream sclera with the pupil on the inner-lower cell, so white
  // reads above and outside the pupil (Aquaxol's proportions).
  for (const sx of [1, -1]) {
    headVox.set(sx * 3, 3, 2, C.horn);
    headVox.set(sx * 2, 3, 2, C.horn);
    headVox.set(sx * 3, 2, 2, C.horn);
    headVox.set(sx * 2, 2, 2, C.eye);
  }
  // Horns: a voxel thicker than before (two columns per side) and swept back on
  // one shared 45° cant, stepped so every cell is face-connected.
  for (const sx of [1, -1]) {
    for (const w of [2, 3]) {
      headVox.set(sx * w, 5, -1, C.horn);
      headVox.set(sx * w, 6, -1, C.horn);
      headVox.set(sx * w, 6, -2, C.horn);
      headVox.set(sx * w, 7, -2, C.horn);
      headVox.set(sx * w, 7, -3, C.horn);
    }
  }
  const headMesh = headVox.build(S);
  headMesh.position.y = -0.30;
  head.add(headMesh);

  // -- lower jaw on a hinge --
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, 0.10);
  head.add(jaw);
  parts.jaw = jaw;

  const jawVox = new VoxelModel();
  jawVox.box(-1, 0, 0, 1, 0, 3, C.belly);
  // (fang voxels removed — they collided with the muzzle and muddied the face)
  const jawMesh = jawVox.build(S, false);
  jawMesh.position.set(-0.05, -0.05, 0);
  jaw.add(jawMesh);

  // -- wings: shoulder pivot + elbow pivot per side --
  const wingR = new THREE.Group();
  wingR.position.set(0.20, 0.18, 0.02);
  body.add(wingR);
  parts.wingR = wingR;
  wingR.add(buildWingInner(1));
  const wingTipR = new THREE.Group();
  wingTipR.position.set(0.38, 0.05, 0);
  wingR.add(wingTipR);
  parts.wingTipR = wingTipR;
  wingTipR.add(buildWingOuter(1));

  const wingL = new THREE.Group();
  wingL.position.set(-0.20, 0.18, 0.02);
  body.add(wingL);
  parts.wingL = wingL;
  wingL.add(buildWingInner(-1));
  const wingTipL = new THREE.Group();
  wingTipL.position.set(-0.38, 0.05, 0);
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
  let flap = 0.45 + Math.sin(t * 2.2) * 0.03; // folded, riding the breath
  let sweep = 1.05; // folded back
  let wingRX = 0;
  let tipFold = 1.35;
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
      flap = beat * (0.75 + 0.25 * k);
      sweep = 0.18;
      tipFold = 0.12;
      tipFlap = Math.sin(w - 0.85) * 0.55; // membrane lag / follow-through
      wingRX = Math.sin(w - 0.4) * 0.10;
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
    + 'rose-crimson scales on cliff quartz and practices its roar at sunrise, every sunrise.',
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
