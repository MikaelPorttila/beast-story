import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';

// ---------------------------------------------------------------------------
// Lumimoth — a radiant moth of warm gold and cream, lantern-tipped.
// ---------------------------------------------------------------------------

const S = 0.1; // voxel scale

const C = {
  cream: 0xf9ecd2,
  creamDk: 0xe8d0a6,
  fuzz: 0xfff8e8,
  gold: 0xffc147,
  goldHot: 0xf29a3a,
  goldDeep: 0xdc8a26,
  spot: 0xfffbf0,
  eye: 0x35204a,
  eyeShine: 0xffffff,
  glow: 0xffe9a3,      // lantern voxels (emissive in their own right)
  glowEmissive: 0xffd75e,
  edge: 0xffcf6a,    // luminous wing rim (emissive)
  under: 0xb5731e,   // shaded wing underside
} as const;

// Base pose constants shared between buildRig() and animate()
const BODY_Y = 0.32;
const ANT_RX = -0.55; // antennae tilt forward
const ANT_RZ = 0.55;  // antennae splay
const WING_REST = 0.16;
const UP_SWEEP = 0.28;  // upper wings swept slightly back
const LO_SWEEP = 0.72;  // lower wings swept back more

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'lumimoth.glimmer-dart',
    name: 'Glimmer Dart',
    description: 'Flicks a needle of condensed moonlight from a wingtip. Travels fast, stings brighter.',
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
    name: 'Prismbeam',
    description: 'Focuses lantern-light through shimmering wings into a piercing ray of dawn.',
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
    name: 'Dust Waltz',
    description: 'A twirling blizzard of luminous wing-dust that dazzles everything nearby.',
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
    name: 'Lantern Blessing',
    description: 'The abdomen-lantern flares with gentle warmth, mending wounds in its soft halo.',
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

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------

function buildAntenna(): THREE.Mesh {
  const v = new VoxelModel();
  // feathered stalk rising with a forward comb
  v.set(0, 0, 0, C.goldDeep);
  v.set(0, 1, 0, C.goldDeep);
  v.set(0, 2, 0, C.goldDeep);
  v.set(0, 3, 1, C.goldDeep);
  v.set(0, 4, 1, C.goldDeep);
  v.set(0, 1, 1, C.gold);
  v.set(0, 2, 1, C.gold);
  v.set(0, 3, 2, C.gold);
  v.set(0, 4, 2, C.gold);
  const m = v.build(S, false);
  m.position.set(-0.05, 0, -0.05);
  return m;
}

/** dir: +1 right wing (extends +x), -1 left wing */
function buildUpperWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  // [backExtent, frontExtent] per column outward from the root.
  // Chord tapers toward the tip so it reads as a wing, not a plank.
  const cols: Array<[number, number]> = [
    [-2, 2], [-3, 3], [-4, 3], [-4, 3], [-3, 2], [-2, 1], [-1, 1],
  ];
  cols.forEach(([z0, z1], i) => {
    for (let z = z0; z <= z1; z++) {
      const edge = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, edge ? C.edge : C.gold);
      // darker underside row beneath the inner span (thins out to the tip)
      if (i < 5 && z > z0 && z < z1) v.set(cell(i), -1, z, C.under);
    }
  });
  // white eye-spots near the wingtip + cream freckle pattern inboard
  v.set(cell(4), 0, 0, C.spot);
  v.set(cell(5), 0, 0, C.spot);
  v.set(cell(4), 0, -1, C.spot);
  v.set(cell(5), 0, -1, C.spot);
  v.set(cell(5), 0, 1, C.spot);
  v.set(cell(2), 0, 1, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.set(cell(3), 0, 2, C.spot);
  v.set(cell(2), 0, -3, C.spot);
  // wing rims glow softly — this is a light-element creature
  v.markEmissive(C.edge, 0.8);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildLowerWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  const cols: Array<[number, number]> = [
    [-3, 1], [-4, 1], [-3, 0], [-2, 0], [-1, -1],
  ];
  cols.forEach(([z0, z1], i) => {
    for (let z = z0; z <= z1; z++) {
      const edge = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, edge ? C.edge : C.goldHot);
      if (i < 3 && z > z0 && z < z1) v.set(cell(i), -1, z, C.under);
    }
  });
  v.set(cell(2), 0, -2, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.set(cell(0), 0, 0, C.spot);
  v.markEmissive(C.edge, 0.8);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;

  // -- thorax: fuzzy cream heart of the moth --
  const thoraxVox = new VoxelModel();
  thoraxVox.ellipsoid(0, 3, 0, 2.6, 2.7, 3.4, C.cream);
  thoraxVox.ellipsoid(0, 4.6, 2.2, 2.9, 1.4, 1.3, C.fuzz); // fluffy collar ruff
  thoraxVox.ellipsoid(0, 1.2, 0.4, 2.2, 1.2, 2.6, C.creamDk); // shaded underside
  const thorax = thoraxVox.build(S);
  thorax.position.y = -0.30;
  body.add(thorax);

  // -- head with big charming eyes --
  const head = new THREE.Group();
  head.position.set(0, 0.08, 0.30);
  body.add(head);
  parts.head = head;

  const headVox = new VoxelModel();
  headVox.ellipsoid(0, 2.2, 0, 2.3, 2.2, 2.1, C.cream);
  headVox.ellipsoid(0, 1.2, 0.6, 1.9, 1.0, 1.7, C.fuzz); // fuzzy cheeks
  for (const sx of [-2, 2]) {
    headVox.set(sx, 2, 0, C.eye);
    headVox.set(sx, 3, 0, C.eye);
    headVox.set(sx, 2, 1, C.eye);
    headVox.set(sx, 3, 1, C.eyeShine); // sparkle
  }
  const headMesh = headVox.build(S);
  headMesh.position.y = -0.22;
  head.add(headMesh);

  // -- feathered antennae --
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

  // -- banded abdomen swinging from the rear --
  const abdomen = new THREE.Group();
  abdomen.position.set(0, 0.02, -0.24);
  body.add(abdomen);
  parts.abdomen = abdomen;

  const abVox = new VoxelModel();
  abVox.ellipsoid(0, 2.4, -2.6, 2.3, 2.3, 3.4, C.creamDk);
  abVox.ellipsoid(0, 2.4, -1.4, 2.35, 2.35, 0.7, C.gold); // lantern bands
  abVox.ellipsoid(0, 2.4, -3.6, 2.15, 2.15, 0.7, C.gold);
  const abMesh = abVox.build(S);
  abMesh.position.set(0, -0.24, -0.26);
  abdomen.add(abMesh);

  // -- glowing lantern tip: the voxels themselves are flagged emissive, so the
  // lantern still reads as lit in a portrait crop even if the halo sprite is
  // culled or the bloom pass is absent. build() hands the emissive cells back
  // in a child mesh — that child is what animate() pulses. --
  const glowVox = new VoxelModel();
  glowVox.ellipsoid(0, 1.2, 0, 1.3, 1.3, 1.5, C.glow);
  glowVox.markEmissive(C.glow, 0.9);
  const glow = glowVox.build(S);
  glow.position.set(0, -0.36, -0.62);
  abdomen.add(glow);
  parts.glow = glow;

  // Fake bloom: warm-gold halo hugging the lantern. Parented to the abdomen
  // (not to the lantern mesh) so it still swings with every animation while
  // glow.children[0] stays the emissive voxel batch. Never frustum-culled.
  const lanternGlow = makeGlowSprite(C.glowEmissive, 0.35, 0.28);
  lanternGlow.position.set(0, -0.21, -0.62);
  lanternGlow.frustumCulled = false;
  abdomen.add(lanternGlow);

  // Slightly larger, very soft halo behind the wings — ambient light-moth
  // aura, deliberately faint so it never becomes a blown-out orb.
  const wingHalo = makeGlowSprite(0xffe08a, 0.55, 0.12);
  wingHalo.position.set(0, 0.1, -0.08);
  wingHalo.frustumCulled = false;
  body.add(wingHalo);

  // -- four wings, upper pair grand, lower pair trailing --
  const wingUR = new THREE.Group();
  wingUR.position.set(0.14, 0.16, 0.06);
  wingUR.rotation.set(0, UP_SWEEP, WING_REST);
  wingUR.add(buildUpperWing(1));
  body.add(wingUR);
  parts.wingUR = wingUR;

  const wingUL = new THREE.Group();
  wingUL.position.set(-0.14, 0.16, 0.06);
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

  return { root, parts, height: 0.62, radius: 0.35 };
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

  // ---- default hover-idle pose ----
  let bodyX = 0;
  let bodyZ = 0;
  let bodyY = BODY_Y + Math.sin(t * 2.6) * 0.035;
  let bodyRX = Math.sin(t * 1.3) * 0.04;
  let bodyRY = 0;
  let bodyRZ = Math.sin(t * 1.1 + 1.7) * 0.05;
  let sq = 1;
  let flap = Math.sin(t * 9) * 0.45 + 0.18;
  let flapLo = Math.sin(t * 9 - 0.7) * 0.36 + 0.12;
  let wingTilt = Math.sin(t * 1.6) * 0.14; // slow shimmer-tilt catchlight
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
      const w = t * (16 + 8 * ctx.moveSpeed);
      const s = Math.sin(w);
      flap = s * (0.55 + 0.5 * k);
      flapLo = Math.sin(w - 0.9) * (0.45 + 0.4 * k);
      wingTilt = -0.12 * k + Math.sin(w - 0.5) * 0.08;
      bodyY = BODY_Y + Math.sin(w - 1.2) * 0.045 * k + Math.sin(t * 2.6) * 0.02;
      bodyRX = 0.22 * k + Math.sin(w - 1.4) * 0.05;
      bodyRZ = Math.sin(t * 1.7) * 0.10 * k; // lazy banking drift
      headRX = -0.18 * k; // keep gaze level against body pitch
      headRY = Math.sin(t * 0.9) * 0.08;
      antLift = 0.5 * k; // antennae streaming back
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
      antLift = -0.30 * rise; // perked
      antSway = Math.sin(t * 14) * 0.05;
      abdRX = 0.35 * rise; // lantern curled forward, presented
      glowI = 0.9 + rise * 2.2 + Math.sin(t * 14) * 0.3 * rise;
      break;
    }
    case 'special': {
      const u = clamp01(at / 1.1);
      const arc = Math.sin(u * Math.PI);
      bodyRY = easeInOutSine(u) * Math.PI * 2; // full pirouette
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
      bodyRX = -0.25 * d; // recoil rearing back
      bodyY = BODY_Y + 0.04 * d;
      headRX = 0.30 * d; // head ducks
      antLift = 0.6 * d; // antennae blown flat
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
      antLift = -0.35; // perked with joy
      antSway = Math.sin(at * 10) * 0.15;
      abdRX = Math.sin(at * 12) * 0.25; // waggle
      glowI = 1.2 + hop * 1.0;
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

  // The lantern's voxels are emissive, so build() moved them into a child mesh
  // with its own material; pulse that (falling back to the parent's material if
  // the lantern ever stops being fully emissive). No allocation per frame.
  const lantern = (p.glow.children.length > 0 ? p.glow.children[0] : p.glow) as THREE.Mesh;
  const glowMat = lantern.material as THREE.MeshStandardMaterial;
  glowMat.emissiveIntensity = glowI * 1.5; // lantern always outshines the wing rims
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'lumimoth',
  name: 'Lumimoth',
  element: 'light',
  locomotion: 'flying',
  description:
    'A radiant moth that drifts between lantern posts at dusk, its glowing tail-light '
    + 'said to guide lost travelers home. Collects starlight on its wing-spots.',
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
