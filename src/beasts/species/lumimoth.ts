import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// Lumimoth — radiant moth of warm gold and cream, lantern-tipped.

const S = 0.1; // voxel scale

const C = {
  cream: 0xf9ecd2,
  creamDk: 0xe8d0a6,
  fuzz: 0xfff8e8,
  gold: 0xffc147,
  goldHot: 0xf29a3a,
  goldDeep: 0xdc8a26,
  spot: 0xfffbf0,
  vein: 0xd98f2e,    // wing veins; `under` is a lighting value, not a pattern
  iris: 0x3a2350,
  eyeShine: 0xfffdf6,
  eyeLid: 0xc9a473,  // cream at ~65%; there is no AO in build(), so paint the recess
  tipGlow: 0xfff1b8,
  leg: 0x6d5136,
  glow: 0xffe9a3,
  glowEmissive: 0xffd75e,
  edge: 0xffcf6a,
  under: 0xc98f34,
} as const;

// Shared between buildRig() and animate()
const BODY_Y = 0.32;
/** Hover height BeastActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;
const ANT_RX = -0.55;
const ANT_RZ = 0.55;
const WING_REST = 0.16;
// Sweep held close to spanwise: raked back, all four wings were foreshortened at once in
// a portrait and the moth read as a starburst of gold bars.
const UP_SWEEP = 0.12;
const LO_SWEEP = 0.42;

export const skills: SkillDef[] = [
  {
    id: 'lumimoth.glimmer-dart',
    nameKey: 'skill.lumimoth.glimmer-dart.name',
    descriptionKey: 'skill.lumimoth.glimmer-dart.desc',
    element: 'light',
    targeting: 'projectile',
    cost: 6,
    cooldown: 1.6,
    power: 10,
    range: 18,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'lumimoth.prismbeam',
    nameKey: 'skill.lumimoth.prismbeam.name',
    descriptionKey: 'skill.lumimoth.prismbeam.desc',
    element: 'light',
    targeting: 'beam',
    cost: 14,
    cooldown: 5.5,
    power: 22,
    range: 15,
    learnAtLevel: 5,
    castAnim: 'cast',
  },
  {
    id: 'lumimoth.dust-waltz',
    nameKey: 'skill.lumimoth.dust-waltz.name',
    descriptionKey: 'skill.lumimoth.dust-waltz.desc',
    element: 'light',
    targeting: 'aoe',
    cost: 16,
    cooldown: 8,
    power: 20,
    range: 6,
    storePrice: 190,
    castAnim: 'special',
  },
  {
    id: 'lumimoth.lantern-blessing',
    nameKey: 'skill.lumimoth.lantern-blessing.name',
    descriptionKey: 'skill.lumimoth.lantern-blessing.desc',
    element: 'light',
    targeting: 'support',
    cost: 20,
    cooldown: 12,
    power: 28,
    range: 8,
    storePrice: 340,
    castAnim: 'special',
  },
];

function buildAntenna(): THREE.Mesh {
  const v = new VoxelModel();
  v.set(0, 0, 0, C.goldDeep);
  v.set(0, 1, 0, C.goldDeep);
  v.set(0, 2, 0, C.goldDeep);
  v.set(0, 3, 1, C.goldDeep);
  v.set(0, 1, 1, C.gold);
  v.set(0, 3, 2, C.gold);
  const m = v.build(S, false);
  m.position.set(-0.05, 0, -0.05);
  return m;
}

// dir: +1 right wing (extends +x), -1 left. Each column carries a shaded second row: a
// one-voxel membrane is zero pixels wide edge-on, which turned the wings into spikes.
function buildUpperWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  // [backExtent, frontExtent] per column outward from the root. Column 0 spans the whole
  // thorax depth so the root is BURIED in the body; the trailing edge zigzags -3/-4 for
  // the scallop a moth hindwing has.
  const cols: Array<[number, number]> = [
    [-3, 3], [-4, 3], [-3, 3], [-4, 2], [-3, 2], [-4, 1], [-2, 1],
  ];
  cols.forEach(([z0, z1], i) => {
    const panel = i <= 2 ? C.goldDeep : C.gold;
    for (let z = z0; z <= z1; z++) {
      const rim = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, rim ? C.edge : panel);
      if (i < 6) v.set(cell(i), -1, z, C.under);
    }
  });
  cols.forEach(([z0, z1], i) => {
    for (const z of [-1, 1]) {
      if (z > z0 && z < z1) v.set(cell(i), 0, z, C.vein);
    }
  });
  // Outermost column plus the aft half of the next in: a lit rim all round drew a neon
  // border, and two whole columns made a flat white paddle.
  for (let z = cols[6][0]; z <= cols[6][1]; z++) v.set(cell(6), 0, z, C.tipGlow);
  v.set(cell(5), 0, cols[5][0], C.tipGlow);
  v.set(cell(4), 0, 0, C.spot);
  v.set(cell(5), 0, 0, C.spot);
  v.set(cell(4), 0, -1, C.spot);
  v.set(cell(5), 0, -1, C.spot);
  v.set(cell(4), 0, 1, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.set(cell(2), 0, 2, C.spot);
  v.markEmissive(C.tipGlow, 0.55);
  v.markEmissive(C.edge, 0.18);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildLowerWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  const cols: Array<[number, number]> = [
    [-4, 2], [-3, 1], [-4, 0], [-2, 0], [-3, -1],
  ];
  cols.forEach(([z0, z1], i) => {
    for (let z = z0; z <= z1; z++) {
      const rim = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, rim ? C.edge : i <= 1 ? C.goldDeep : C.goldHot);
      if (i < 4) v.set(cell(i), -1, z, C.under);
    }
  });
  cols.forEach(([z0, z1], i) => {
    if (-1 > z0 && -1 < z1) v.set(cell(i), 0, -1, C.vein);
  });
  v.set(cell(4), 0, cols[4][0], C.tipGlow);
  v.set(cell(4), 0, cols[4][1], C.tipGlow);
  v.set(cell(2), 0, -2, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.markEmissive(C.tipGlow, 0.55);
  v.markEmissive(C.edge, 0.18);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;

  const thoraxVox = new VoxelModel();
  thoraxVox.ellipsoid(0, 3.2, 0, 3.1, 3.1, 3.8, C.cream);
  thoraxVox.ellipsoid(0, 5.0, 2.2, 3.2, 1.5, 1.4, C.fuzz);
  thoraxVox.ellipsoid(0, 1.2, 0.4, 2.4, 1.2, 2.8, C.creamDk);
  // Shoulder coverts: fuzz where each wing root enters, or a wedge of sky shows through
  // and the wings read as bolted on.
  for (const sx of [1, -1]) {
    for (let z = -1; z <= 2; z++) {
      thoraxVox.set(sx * 2, 5, z, C.fuzz);
      thoraxVox.set(sx * 3, 4, z, C.fuzz);
    }
  }
  for (const sx of [1, -1]) {
    thoraxVox.set(sx * 1, 0, 2, C.leg);
    thoraxVox.set(sx * 2, 0, 1, C.leg);
    thoraxVox.set(sx * 1, 0, -1, C.leg);
  }
  shadeUnder(thoraxVox, C.under, -3, 3, 1, 2, -3, 3); // from y=1, so it spares the legs
  const thorax = thoraxVox.build(S);
  // -0.40: build() anchors y=0 at the lowest voxel and the tucked legs add a row below.
  thorax.position.y = -0.40;
  body.add(thorax);

  const head = new THREE.Group();
  head.position.set(0, 0.08, 0.30);
  body.add(head);
  parts.head = head;

  const headVox = new VoxelModel();
  headVox.ellipsoid(0, 2.2, 0, 2.9, 2.1, 2.0, C.cream);
  headVox.ellipsoid(0, 1.1, 0.8, 2.0, 1.0, 1.6, C.fuzz);
  headVox.box(-3, 2, 2, 3, 4, 2, C.cream);
  rimTop(headVox, C.fuzz, -2, 2, 0, 4, -2, 2);
  shadeUnder(headVox, C.creamDk, -3, 3, 0, 1, -2, 1);
  eyes2x2(headVox, {
    inner: 1, y: 2, faceZ: 2, iris: C.iris, shine: C.eyeShine,
    lid: C.eyeLid, browProud: true, bridge: C.fuzz,
  });
  const headMesh = headVox.build(S);
  headMesh.position.y = -0.22;
  head.add(headMesh);

  const antL = new THREE.Group();
  antL.position.set(-0.09, 0.18, 0.06);
  antL.rotation.set(ANT_RX, 0, ANT_RZ);
  antL.add(buildAntenna());
  head.add(antL);
  parts.antL = antL;

  const antR = new THREE.Group();
  antR.position.set(0.09, 0.18, 0.06);
  antR.rotation.set(ANT_RX, 0, -ANT_RZ);
  antR.add(buildAntenna());
  head.add(antR);
  parts.antR = antR;

  const abdomen = new THREE.Group();
  abdomen.position.set(0, 0.02, -0.24);
  body.add(abdomen);
  parts.abdomen = abdomen;

  const abVox = new VoxelModel();
  abVox.ellipsoid(0, 2.4, -2.6, 2.3, 2.3, 3.4, C.creamDk);
  abVox.ellipsoid(0, 2.4, -1.4, 2.35, 2.35, 0.7, C.gold);
  abVox.ellipsoid(0, 2.4, -3.6, 2.15, 2.15, 0.7, C.gold);
  abVox.markEmissive(C.gold, 0.3);
  const abMesh = abVox.build(S);
  abMesh.position.set(0, -0.24, -0.26);
  abdomen.add(abMesh);

  const glowVox = new VoxelModel();
  glowVox.ellipsoid(0, 1.2, 0, 1.3, 1.3, 1.5, C.glow);
  // 0.5, and animate() still multiplies by 1.5: under bloom the lantern was a white
  // sphere that ate the abdomen bands.
  glowVox.markEmissive(C.glow, 0.5);
  const glow = glowVox.build(S);
  glow.position.set(0, -0.36, -0.62);
  abdomen.add(glow);
  parts.glow = glow;

  // Parented to the abdomen, not the lantern mesh, so glow.children[0] stays the emissive
  // voxel batch animate() pulses. 0.22/0.08 because those voxels already bloom.
  const lanternGlow = makeGlowSprite(C.glowEmissive, 0.22, 0.08);
  lanternGlow.position.set(0, -0.21, -0.62);
  lanternGlow.frustumCulled = false;
  abdomen.add(lanternGlow);

  const wingHalo = makeGlowSprite(0xffe08a, 0.34, 0.04);
  wingHalo.position.set(0, 0.1, -0.08);
  wingHalo.frustumCulled = false;
  body.add(wingHalo);

  const wingUR = new THREE.Group();
  wingUR.position.set(0.14, 0.16, -0.04);
  wingUR.rotation.set(0, UP_SWEEP, WING_REST);
  wingUR.add(buildUpperWing(1));
  body.add(wingUR);
  parts.wingUR = wingUR;

  const wingUL = new THREE.Group();
  wingUL.position.set(-0.14, 0.16, -0.04);
  wingUL.rotation.set(0, -UP_SWEEP, -WING_REST);
  wingUL.add(buildUpperWing(-1));
  body.add(wingUL);
  parts.wingUL = wingUL;

  const wingLR = new THREE.Group();
  wingLR.position.set(0.12, 0.06, -0.08);
  wingLR.rotation.set(0, LO_SWEEP, WING_REST * 0.7);
  wingLR.add(buildLowerWing(1));
  body.add(wingLR);
  parts.wingLR = wingLR;

  const wingLL = new THREE.Group();
  wingLL.position.set(-0.12, 0.06, -0.08);
  wingLL.rotation.set(0, -LO_SWEEP, -WING_REST * 0.7);
  wingLL.add(buildLowerWing(-1));
  body.add(wingLL);
  parts.wingLL = wingLL;

  // Ground contact blob — see contactshadow.ts; the real shadow lands behind it from
  // 1.55 units up under a low sun.
  const blob = makeContactBlob(0.6, HOVER, 0.3);
  root.add(blob);
  parts.blob = blob;

  return { root, parts, height: 0.66, radius: 0.36 };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

// Wingbeat phase, integrated — see BeastAnimCtx.cycle(). The fastest cycle in the roster
// (16-24 rad/s), so off the session clock a sliver of gait blend jumped it seven beats.
const BEAT = 0;

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  updateContactBlob(p.blob, rig.root, 1 + 0.2 * clamp01(1 - p.wingUR.rotation.z), ctx.altitude);

  // Rate picked BEFORE the phase is integrated — a slot advances exactly once a frame —
  // and outside the switch, so hover and cruise share one continuous phase.
  const moving = ctx.action === 'fly' || ctx.action === 'walk'
    || ctx.action === 'run' || ctx.action === 'swim';
  const w = ctx.cycle(BEAT, moving ? 16 + 8 * ctx.moveSpeed : 9);

  let bodyX = 0;
  let bodyZ = 0;
  let bodyY = BODY_Y + Math.sin(t * 2.6) * 0.035;
  let bodyRX = Math.sin(t * 1.3) * 0.04;
  let bodyRY = 0;
  let bodyRZ = Math.sin(t * 1.1 + 1.7) * 0.05;
  let sq = 1;
  let flap = Math.sin(w) * 0.45 + 0.18;
  let flapLo = Math.sin(w - 0.7) * 0.36 + 0.12;
  let wingTilt = Math.sin(t * 1.6) * 0.14;
  let headRX = Math.sin(t * 0.7) * 0.10;
  let headRY = Math.sin(t * 0.43) * 0.16;
  let headRZ = Math.sin(t * 0.9 + 2.0) * 0.06;
  let antSway = Math.sin(t * 2.2) * 0.10;
  let antLift = 0;
  let abdRX = Math.sin(t * 2.0 + 1.0) * 0.09;
  let abdRY = Math.sin(t * 1.4) * 0.06;
  let glowI = 0.85 + Math.sin(t * 3.2) * 0.30;

  switch (ctx.action) {
    case 'fly':
    case 'walk':
    case 'run':
    case 'swim': {
      const k = 0.4 + 0.6 * ctx.moveSpeed;
      const s = Math.sin(w);
      // Beat biased below level: a symmetric stroke stands the wings vertical at both
      // extremes, and a still frame usually lands on an extreme.
      flap = -0.18 + s * (0.42 + 0.38 * k);
      flapLo = -0.14 + Math.sin(w - 0.9) * (0.36 + 0.3 * k);
      wingTilt = 0.22 - 0.1 * k + Math.sin(w - 0.5) * 0.08;
      bodyY = BODY_Y + Math.sin(w - 1.2) * 0.045 * k + Math.sin(t * 2.6) * 0.02;
      bodyRX = 0.22 * k + Math.sin(w - 1.4) * 0.05;
      bodyRZ = Math.sin(t * 1.7) * 0.10 * k;
      headRX = -0.18 * k;
      headRY = Math.sin(t * 0.9) * 0.08;
      antLift = 0.5 * k;
      abdRX = -0.10 * k + Math.sin(w - 1.8) * 0.10;
      abdRY = Math.sin(t * 1.7) * 0.05;
      glowI = 1.0 + Math.sin(t * 6) * 0.25;
      break;
    }
    case 'attack': {
      const wind = easeOutCubic(clamp01(at / 0.14));
      const lunge = easeOutCubic(clamp01((at - 0.14) / 0.16));
      const settle = easeInOutSine(clamp01((at - 0.30) / 0.30));
      const punch = lunge * (1 - settle);
      const coil = wind * (1 - lunge);
      bodyRX = -0.35 * coil + 0.55 * punch;
      bodyZ = -0.06 * coil + 0.16 * punch;
      bodyY = BODY_Y + 0.05 * coil - 0.03 * punch;
      sq = 1 - 0.06 * coil + 0.06 * punch;
      flap = Math.sin(t * 30) * 0.8;
      flapLo = Math.sin(t * 30 - 0.8) * 0.6;
      wingTilt = -0.4 * punch;
      headRX = -0.2 * coil + 0.28 * punch;
      antLift = 0.45 * punch;
      abdRX = 0.25 * coil - 0.2 * punch;
      glowI = 0.9 + punch * 1.3;
      break;
    }
    case 'cast': {
      const rise = easeOutCubic(clamp01(at / 0.35));
      const quiver = Math.sin(t * 26) * 0.06 * rise;
      bodyRX = -0.45 * rise;
      bodyY = BODY_Y + 0.10 * rise + Math.sin(t * 3) * 0.02;
      flap = 0.9 * rise + quiver;
      flapLo = 0.6 * rise + quiver;
      wingTilt = 0.25 * rise;
      headRX = -0.25 * rise;
      antLift = -0.30 * rise;
      antSway = Math.sin(t * 14) * 0.05;
      abdRX = 0.35 * rise;
      glowI = 0.9 + rise * 2.2 + Math.sin(t * 14) * 0.3 * rise;
      break;
    }
    case 'special': {
      const u = clamp01(at / 1.1);
      const arc = Math.sin(u * Math.PI);
      bodyRY = easeInOutSine(u) * Math.PI * 2;
      bodyY = BODY_Y + arc * 0.22;
      sq = 1 + arc * 0.08;
      flap = Math.sin(t * 26) * 1.0;
      flapLo = Math.sin(t * 26 - 0.8) * 0.8;
      wingTilt = 0.3 * arc;
      headRX = -0.2 * arc;
      antLift = -0.35 * arc;
      abdRX = 0.3 * arc;
      abdRY = Math.sin(t * 8) * 0.1;
      glowI = 1 + arc * 2.6;
      break;
    }
    case 'hurt': {
      const d = Math.max(0, 1 - at / 0.45);
      bodyX = Math.sin(at * 55) * 0.045 * d;
      bodyRZ = Math.sin(at * 48) * 0.14 * d;
      bodyRX = -0.25 * d;
      bodyY = BODY_Y + 0.04 * d;
      headRX = 0.30 * d;
      antLift = 0.6 * d;
      flap = Math.sin(t * 34) * 0.9 * d + 0.2;
      flapLo = Math.sin(t * 34 - 0.6) * 0.7 * d + 0.15;
      abdRX = 0.3 * d;
      glowI = 0.35;
      break;
    }
    case 'happy': {
      const hop = Math.abs(Math.sin(at * 7));
      bodyY = BODY_Y + hop * 0.14;
      sq = 1 + Math.sin(at * 14) * 0.06;
      bodyRZ = Math.sin(at * 7) * 0.12;
      bodyRY = Math.sin(at * 3.5) * 0.35;
      flap = Math.sin(t * 20) * 0.7 + 0.2;
      flapLo = Math.sin(t * 20 - 0.7) * 0.55 + 0.15;
      wingTilt = Math.sin(at * 7) * 0.15;
      headRZ = Math.sin(at * 7) * 0.18;
      headRX = -0.12;
      antLift = -0.35;
      antSway = Math.sin(at * 10) * 0.15;
      abdRX = Math.sin(at * 12) * 0.25;
      glowI = 1.2 + hop * 1.0;
      break;
    }
    case 'idle':
    default:
      break;
  }

  const body = p.body;
  body.position.set(bodyX, bodyY, bodyZ);
  body.rotation.set(bodyRX, bodyRY, bodyRZ);
  const xz = 1 + (1 - sq) * 0.6;
  body.scale.set(xz, sq, xz);

  p.head.rotation.set(headRX, headRY, headRZ);
  p.antL.rotation.set(ANT_RX + antLift + antSway, 0, ANT_RZ);
  p.antR.rotation.set(ANT_RX + antLift - antSway, 0, -ANT_RZ);
  p.abdomen.rotation.set(abdRX, abdRY, 0);

  p.wingUR.rotation.set(wingTilt, UP_SWEEP, WING_REST + flap);
  p.wingUL.rotation.set(wingTilt, -UP_SWEEP, -(WING_REST + flap));
  p.wingLR.rotation.set(wingTilt * 0.7, LO_SWEEP, WING_REST * 0.7 + flapLo);
  p.wingLL.rotation.set(wingTilt * 0.7, -LO_SWEEP, -(WING_REST * 0.7 + flapLo));

  // build() moved the emissive voxels into a child mesh with its own material; pulse that,
  // falling back to the parent if the lantern ever stops being fully emissive.
  const lantern = (p.glow.children.length > 0 ? p.glow.children[0] : p.glow) as THREE.Mesh;
  const glowMat = lantern.material as THREE.MeshStandardMaterial;
  glowMat.emissiveIntensity = glowI * 0.9;
}

export const species: BeastSpecies = {
  id: 'lumimoth',
  nameKey: 'beast.lumimoth.name',
  element: 'light',
  locomotion: 'flying',
  descriptionKey: 'beast.lumimoth.desc',
  baseStats: { maxHp: 34, attack: 9, defense: 6, speed: 5.2 },
  skills: [
    'lumimoth.glimmer-dart',
    'lumimoth.prismbeam',
    'lumimoth.dust-waltz',
    'lumimoth.lantern-blessing',
  ],
  buildRig,
  animate,
};
