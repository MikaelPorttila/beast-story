import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// Drakelet — pocket dragon in ember-crimson scale: two-segment bat wings with membrane,
// a chest that puffs before a breath attack, three-segment whip tail, horns, spikes.

const S = 0.1; // voxel scale

const C = {
  scale: 0xd94a44,
  scaleDk: 0x9a2c2c,
  scaleLt: 0xff8168,
  belly: 0xf9e6c6,
  bellyDk: 0xdcb589,
  horn: 0xfff3e0,
  claw: 0xfff3e0,
  spike: 0x7d2422,
  // Membrane sits two steps above where it started: at ~15% luminance the wings were
  // black slivers and the pale arm bone read as a stick floating beside the dragon.
  membrane: 0xb8443c,
  membraneDk: 0x8a2f2b,
  membraneLt: 0xd06052,
  wingBone: 0xe3c288,
  // Dark iris, bright catchlight, as everywhere in the roster: a pale iris merged into
  // this cream face plate and left only the pupil, which read as a black eye slot.
  iris: 0x38131a,
  eyeShine: 0xfff6dd,
  eyeLid: 0x8a2320,
  nostril: 0x6b1f1c,
} as const;

// Shared between buildRig() and animate()
const BODY_Y = 0.52;
/** Hover height BeastActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;

export const skills: SkillDef[] = [
  {
    id: 'drakelet.fang-rush',
    nameKey: 'skill.drakelet.fang-rush.name',
    descriptionKey: 'skill.drakelet.fang-rush.desc',
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
    nameKey: 'skill.drakelet.drakefire-breath.name',
    descriptionKey: 'skill.drakelet.drakefire-breath.desc',
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
    nameKey: 'skill.drakelet.tailspin-tempest.name',
    descriptionKey: 'skill.drakelet.tailspin-tempest.desc',
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
    nameKey: 'skill.drakelet.comet-crash.name',
    descriptionKey: 'skill.drakelet.comet-crash.desc',
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

// Inner wing, all on one plane at y=0 and face-connected: diagonally adjacent masses share
// no face. The y=1 and y=-1 rows are thickness, so the wing survives edge-on.
function buildWingInner(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  for (let i = 0; i < 4; i++) {
    v.set(cell(i), 0, 1, C.wingBone);
    if (i < 2) v.set(cell(i), 1, 1, C.wingBone);
    v.set(cell(i), 0, 0, C.membraneLt);
    v.set(cell(i), 0, -1, C.membrane);
    v.set(cell(i), 0, -2, i < 3 ? C.membrane : C.membraneDk);
    if (i < 3) v.set(cell(i), 0, -3, C.membraneDk);
    v.set(cell(i), -1, 1, C.membraneDk);
    v.set(cell(i), -1, 0, C.membraneDk);
  }
  v.set(cell(3), 2, 1, C.wingBone);
  const m = v.build(S, false);
  m.position.set(0, -0.15, -0.02);
  return m;
}

/** Outer wing: hand, finger ribs, scalloped membrane fan. */
function buildWingOuter(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  const depth = [4, 5, 6, 6, 5, 3]; // chord per column; shallow at the root left a gap
  for (let i = 0; i < 6; i++) {
    v.set(cell(i), 0, 1, C.wingBone);
    if (i < 2) v.set(cell(i), 1, 1, C.wingBone);
    v.set(cell(i), -1, 1, C.membraneDk);
    for (let z = 0; z >= -depth[i]; z--) {
      const trailing = z === -depth[i];
      v.set(cell(i), 0, z, trailing ? C.membraneDk : z > -2 ? C.membraneLt : C.membrane);
    }
  }
  // Each finger bone is one CONTINUOUS line down its column; staggered cells read as noise.
  for (const i of [2, 4]) {
    for (let z = 0; z >= -depth[i]; z--) v.set(cell(i), 0, z, C.scaleDk);
  }
  v.set(cell(5), 1, 1, C.claw);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildLeg(): THREE.Mesh {
  const v = new VoxelModel();
  v.ellipsoid(0, 1.6, -0.2, 1.5, 1.5, 1.6, C.scale);
  v.box(-1, 0, -1, 0, 0, 1, C.scale);
  v.set(-1, 0, 2, C.claw);
  v.set(0, 0, 2, C.claw);
  const m = v.build(S);
  m.position.y = -0.30;
  return m;
}

function buildArm(): THREE.Mesh {
  const v = new VoxelModel();
  v.box(-1, 1, -1, 0, 2, 0, C.scale);
  v.box(-1, 0, 0, 0, 0, 1, C.scale);
  v.set(-1, 0, 2, C.claw);
  v.set(0, 0, 2, C.claw);
  const m = v.build(S);
  m.position.y = -0.26;
  return m;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;

  const torsoVox = new VoxelModel();
  torsoVox.ellipsoid(0, 3.6, -0.5, 3.2, 3.6, 4.4, C.scale);
  torsoVox.ellipsoid(2.5, 2.4, -2.2, 1.5, 1.9, 1.9, C.scale);
  torsoVox.ellipsoid(-2.5, 2.4, -2.2, 1.5, 1.9, 1.9, C.scale);
  torsoVox.ellipsoid(0, 5.4, -0.5, 2.4, 1.8, 3.6, C.scaleLt);
  shadeUnder(torsoVox, C.scaleDk, -4, 4, 0, 5, -5, 5);
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

  const chest = new THREE.Group();
  chest.position.set(0, -0.06, 0.16);
  body.add(chest);
  parts.chest = chest;

  const chestVox = new VoxelModel();
  chestVox.ellipsoid(0, 2.8, 1.4, 1.9, 2.5, 2.3, C.belly);
  chestVox.ellipsoid(0, 4.0, 1.5, 1.95, 0.5, 2.35, C.bellyDk);
  chestVox.ellipsoid(0, 2.5, 1.5, 1.95, 0.5, 2.35, C.bellyDk);
  chestVox.ellipsoid(0, 1.2, 1.5, 1.8, 0.5, 2.2, C.bellyDk);
  shadeUnder(chestVox, C.bellyDk, -2, 2, 0, 3, -1, 4);
  const chestMesh = chestVox.build(S);
  chestMesh.position.set(0, -0.32, 0.02);
  chest.add(chestMesh);

  const head = new THREE.Group();
  head.position.set(0, 0.24, 0.30);
  body.add(head);
  parts.head = head;

  const headVox = new VoxelModel();
  headVox.ellipsoid(0, 2.8, -0.2, 3.4, 2.7, 3.0, C.scale);
  // Stepped snout, darkening downward so the pale block sits on a jaw. Starts at z=4, clear
  // of the brow plate painted after it, and tops out at y=2 or it hides the eyes.
  const snout: Array<[number, number, number, number]> = [
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
  headVox.set(-1, 2, 5, C.nostril);
  headVox.set(1, 2, 5, C.nostril);
  headVox.box(-3, 2, 3, 3, 5, 3, C.scale);   // brow plate up to row 5, a face for the eye
  rimTop(headVox, C.scaleLt, -3, 3, 0, 6, -3, 4);
  shadeUnder(headVox, C.scaleDk, -3, 3, 0, 3, -3, 2);
  // Pale mask across the eye rows before the eyes go in: a dark crimson iris on a crimson
  // brow has no boundary in shade, and only the catchlights survived.
  for (let x = -3; x <= 3; x++) {
    headVox.set(x, 3, 3, C.bellyDk);
    headVox.set(x, 4, 3, C.belly);
  }
  eyes2x2(headVox, {
    // inner: 1 — at 2 the outer column is the very edge of this wide skull, so the iris
    // hid round the curve and only the pupil showed.
    inner: 1, y: 3, faceZ: 3, iris: C.iris, shine: C.eyeShine,
    lid: C.eyeLid, browProud: true, bridge: C.belly,
  });
  // Horns root INSIDE the cranium and climb aft solidly, or sky shows between horn and crown.
  for (const sx of [1, -1]) {
    for (const w of [2, 3]) {
      const step: Array<[number, number]> = [
        [3, 1], [3, 0], [4, 0], [4, -1], [5, -1], [5, -2], [6, -2], [6, -3], [7, -3],
      ];
      for (const [y, z] of step) headVox.set(sx * w, y, z, C.horn);
    }
  }
  const headMesh = headVox.build(S);
  // +0.05z pays for the extra snout step: build() re-centres on the bounding box.
  headMesh.position.set(0, -0.30, 0.05);
  head.add(headMesh);

  const jaw = new THREE.Group();
  jaw.position.set(0, -0.12, 0.10);
  head.add(jaw);
  parts.jaw = jaw;

  const jawVox = new VoxelModel();
  // Dark scale, not cream: this is the volume UNDER the pale muzzle and needs a chin line.
  jawVox.box(-1, 0, 0, 1, 0, 3, C.scaleDk);
  jawVox.set(0, 0, 3, C.bellyDk);
  const jawMesh = jawVox.build(S, false);
  jawMesh.position.set(-0.05, -0.05, 0);
  jaw.add(jawMesh);

  const wingR = new THREE.Group();
  // |x| = 0.14 against a 0.32 half-width buries the root two cells inside the barrel; on the
  // edge, a rotated shoulder swung the first membrane column clear of the body.
  wingR.position.set(0.14, 0.06, -0.08);
  body.add(wingR);
  parts.wingR = wingR;
  wingR.add(buildWingInner(1));
  const wingTipR = new THREE.Group();
  // 0.34: the inner section ends at 0.40 from its own pivot, so the hand overlaps the
  // forearm by a cell and the elbow cannot open a seam.
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

  const tail1 = new THREE.Group();
  tail1.position.set(0, -0.10, -0.36);
  body.add(tail1);
  parts.tail1 = tail1;

  const t1Vox = new VoxelModel();
  t1Vox.ellipsoid(0, 0, -2, 1.6, 1.6, 2.4, C.scale);
  t1Vox.set(0, 2, -2, C.spike);
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
  t3Vox.set(0, 0, -1, C.scaleDk);
  t3Vox.set(0, 0, -2, C.scaleDk);
  t3Vox.set(0, 0, -3, C.spike);
  t3Vox.set(0, 0, -4, C.spike);
  t3Vox.set(-1, 0, -3, C.spike);
  t3Vox.set(1, 0, -3, C.spike);
  t3Vox.set(0, 1, -3, C.spike);
  t3Vox.set(0, -1, -3, C.spike);
  t3Vox.set(0, 0, -5, C.spike);
  const t3Mesh = t3Vox.build(S, false);
  t3Mesh.position.set(-0.05, -0.05, 0);
  tail3.add(t3Mesh);

  // Ground contact blob — see contactshadow.ts.
  const blob = makeContactBlob(0.7, HOVER);
  root.add(blob);
  parts.blob = blob;

  return { root, parts, height: 1.15, radius: 0.45 };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

// Wingbeat phase, integrated — see BeastAnimCtx.cycle(). moveSpeed scales the rate, so
// off the session clock a change of pace rewrote the phase by whole beats.
const BEAT = 0;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  let bodyX = 0;
  let bodyZ = 0;
  let bodyY = BODY_Y + Math.sin(t * 2.2) * 0.02;
  let bodyRX = 0;
  let bodyRY = 0;
  let bodyRZ = Math.sin(t * 1.1) * 0.02;
  let sq = 1;
  let chestS = 1 + Math.sin(t * 2.2) * 0.035;
  let headRX = Math.sin(t * 0.9) * 0.06 - 0.05;
  let headRY = Math.sin(t * 0.5) * 0.22;
  let headRZ = Math.sin(t * 0.7 + 1) * 0.05;
  let jawOpen = 0.06 + Math.sin(t * 2.2) * 0.02;
  // Perched wings furl UP, membrane rolled vertical like a bat's; flat they read as planks.
  let flap = 1.15 + Math.sin(t * 2.2) * 0.03;
  let sweep = 0.55;
  let wingRX = 0.85;
  let tipFold = 2.0;
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
      const w = ctx.cycle(BEAT, 7.5 + 3.5 * ctx.moveSpeed);
      const raw = Math.sin(w);
      const beat = Math.sign(raw) * Math.abs(raw) ** 0.75;
      // Peak flap 0.52-0.70: past vertical the wing plane is edge-on half the stroke.
      flap = beat * (0.52 + 0.18 * k);
      sweep = 0.18;
      tipFold = 0.12;
      tipFlap = Math.sin(w - 0.85) * 0.55;
      // Standing roll on top of the beat: a purely horizontal membrane passed edge-on
      // through the middle of every stroke.
      wingRX = 0.34 + Math.sin(w - 0.4) * 0.14;
      bodyY = BODY_Y + Math.sin(w - 1.1) * 0.07 * k + 0.06;
      bodyRX = 0.30 * k + Math.sin(w - 1.3) * 0.06;
      bodyRZ = Math.sin(t * 1.6) * 0.08 * k;
      headRX = -0.22 * k + Math.sin(w - 1.5) * 0.04;
      headRY = Math.sin(t * 0.8) * 0.10;
      jawOpen = 0.05;
      chestS = 1 + Math.sin(w) * 0.02;
      legRX = 0.85;
      armRX = 0.70;
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
      jawOpen = 0.7 * Math.max(coil * 0.7, lunge) * (1 - snap);
      flap = 0.6 * coil - 0.35 * punch;
      sweep = 0.35 + 0.5 * punch;
      tipFold = 0.25 + 0.4 * punch;
      tipFlap = -0.2 * punch;
      chestS = 1 + 0.05 * coil;
      legRX = 0.3 * punch;
      armRX = -0.4 * punch;
      tailRX1 = 0.2 * coil - 0.25 * punch;
      tailRX2 = 0.12 * coil - 0.18 * punch;
      tailRX3 = 0.06 * coil - 0.12 * punch;
      tailRY1 = Math.sin(t * 6) * 0.06;
      tailRY2 = Math.sin(t * 6 - 0.5) * 0.08;
      tailRY3 = Math.sin(t * 6 - 1.0) * 0.10;
      break;
    }
    case 'cast': {
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
      const rise = easeOutCubic(clamp01(at / 0.35));
      const fall = easeInOutSine(clamp01((at - 0.85) / 0.35));
      const amp = rise * (1 - fall);
      bodyRX = -0.55 * amp;
      bodyY = BODY_Y + 0.16 * amp + Math.sin(t * 12) * 0.01;
      sq = 1 + 0.06 * amp;
      chestS = 1 + 0.12 * amp;
      headRX = -0.30 * amp + Math.sin(t * 10) * 0.04 * amp;
      headRY = 0;
      jawOpen = 0.8 * amp;
      flap = amp * (0.4 + Math.sin(t * 16) * 0.55);
      sweep = 0.15;
      tipFold = 0.10;
      tipFlap = Math.sin(t * 16 - 0.8) * 0.5 * amp;
      wingRX = Math.sin(t * 16 - 0.4) * 0.08 * amp;
      legRX = 0.5 * amp;
      legSplit = 0.15 * amp;
      armRX = -0.6 * amp;
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
      bodyRX = -0.18 * d;
      bodyY = BODY_Y + 0.03 * d;
      headRX = 0.25 * d;
      headRZ = Math.sin(at * 40) * 0.08 * d;
      jawOpen = 0.4 * d;
      flap = 0.7 * d + Math.sin(t * 26) * 0.4 * d;
      sweep = 0.3 + 0.5 * (1 - d);
      tipFold = 0.3 + 0.8 * (1 - d);
      chestS = 1 - 0.05 * d;
      armRX = 0.5 * d;
      legRX = 0.3 * d;
      tailRX1 = -0.15 * d;
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
      sq = 1 + Math.sin(at * 13) * 0.07;
      bodyRY = Math.sin(at * 3.2) * 0.40;
      bodyRZ = Math.sin(at * 6.5) * 0.08;
      headRX = -0.10;
      headRZ = Math.sin(at * 6.5) * 0.15;
      headRY = Math.sin(at * 3.2) * 0.15;
      jawOpen = 0.35 + Math.sin(at * 13) * 0.10;
      flap = 0.3 + Math.sin(at * 13) * 0.35;
      sweep = 0.5;
      tipFold = 0.4;
      tipFlap = Math.sin(at * 13 - 0.6) * 0.3;
      chestS = 1 + hop * 0.05;
      armRX = -0.3 + Math.sin(at * 13) * 0.20;
      armSplit = Math.sin(at * 13) * 0.1;
      legRX = 0.2 + hop * 0.15;
      tailRX1 = 0.1;
      tailRY1 = Math.sin(at * 11) * 0.45;
      tailRY2 = Math.sin(at * 11 - 0.6) * 0.55;
      tailRY3 = Math.sin(at * 11 - 1.2) * 0.65;
      break;
    }
    case 'idle':
    default:
      break;
  }

  updateContactBlob(p.blob, rig.root, 1 + 0.25 * clamp01(1 - Math.abs(sweep)), ctx.altitude);

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

export const species: BeastSpecies = {
  id: 'drakelet',
  nameKey: 'beast.drakelet.name',
  element: 'dragon',
  locomotion: 'flying',
  descriptionKey: 'beast.drakelet.desc',
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
