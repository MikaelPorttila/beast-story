import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Frostwing — a snowy owl of the high glaciers. Ice element, flying.
// Voxel scale 0.1: stands ~0.92 tall, wingspan ~2.2 when spread.
// ---------------------------------------------------------------------------

// Palette
const WHITE = 0xf8fbff;   // snow plumage
const CREAM = 0xe7f1fa;   // soft under-feathers
const SPECK = 0xa6dbf2;   // ice-blue speckle
const SPECK2 = 0x83cbee;  // deeper ice-blue (wingtips)
const UNDER = 0xbdd4e6;   // shaded wing underside
const DISC = 0xc7e1f2;    // heart facial-disc rim
const BEAK = 0x39404d;    // small dark beak
const EYE = 0xffc63f;     // amber iris rim
const SCLERA = 0xffffff;  // white sclera — keeps the gaze open, not masked
const PUPIL = 0x101318;   // pupils
const TALON = 0x525b69;   // talons

const BODY_Y = 0.38;
const HEAD_X = 0, HEAD_Y = 0.12, HEAD_Z = 0.10;

type Parts = Record<string, THREE.Object3D>;

const s01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => { const x = s01(t); return x * x * (3 - 2 * x); };
const decay = (t: number, r: number): number => Math.exp(-r * Math.max(0, t));
/** Eased 0 -> 1 -> 0 bump inside [a, b]; riseFrac = fraction of window spent rising */
function bump(t: number, a: number, b: number, riseFrac = 0.4): number {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return u < riseFrac ? smooth(u / riseFrac) : smooth((1 - u) / (1 - riseFrac));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'frostwing.frost-dart',
    name: 'Frost Dart',
    description: 'Flicks a razor feather of ice that chills whatever it pricks.',
    element: 'ice', targeting: 'projectile',
    cost: 6, cooldown: 1.8, power: 11, range: 20,
    learnAtLevel: 1, castAnim: 'attack',
  },
  {
    id: 'frostwing.blizzard-wing',
    name: 'Blizzard Wing',
    description: 'One mighty wingbeat whips up a stinging ring of snow around the owl.',
    element: 'ice', targeting: 'aoe',
    cost: 14, cooldown: 6, power: 22, range: 6,
    learnAtLevel: 5, castAnim: 'cast',
  },
  {
    id: 'frostwing.aurora-veil',
    name: 'Aurora Veil',
    description: 'Weaves shimmering polar light overhead that gently mends allies beneath it.',
    element: 'ice', targeting: 'support',
    cost: 18, cooldown: 9, power: 20, range: 8,
    storePrice: 220, castAnim: 'cast',
  },
  {
    id: 'frostwing.comet-dive',
    name: 'Comet Dive',
    description: 'Folds its wings and falls like a frozen star. Impact included, free of charge.',
    element: 'ice', targeting: 'melee',
    cost: 22, cooldown: 11, power: 40, range: 4,
    storePrice: 360, castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** One hinged wing section. Cells run outward from the pivot along +/-X. */
function wingSectionMesh(sign: number, kind: 'inner' | 'mid' | 'tip'): THREE.Mesh {
  const m = new VoxelModel();
  const col = (d: number, z0: number, z1: number, c: number): void => {
    const x = sign > 0 ? d : -d - 1; // exact mirror of cell columns
    for (let z = z0; z <= z1; z++) m.set(x, 0, z, c);
  };
  const one = (d: number, y: number, z: number, c: number): void => {
    m.set(sign > 0 ? d : -d - 1, y, z, c);
  };
  if (kind === 'inner') {
    col(0, -1, 2, WHITE); col(1, -2, 2, WHITE); col(2, -2, 2, WHITE);
    one(1, 0, -2, SPECK); one(0, 0, 2, CREAM);
    // chunky leading edge (second voxel layer at the front)
    one(0, 1, 2, CREAM); one(1, 1, 2, CREAM); one(2, 1, 2, CREAM);
    // darker underside row — the wing has a belly now, not plank symmetry
    one(0, -1, 0, UNDER); one(0, -1, 1, UNDER);
    one(1, -1, 0, UNDER); one(1, -1, 1, UNDER); one(2, -1, 0, UNDER);
  } else if (kind === 'mid') {
    // chord tapers 5 -> 4 -> 3 heading out toward the tip
    col(0, -2, 2, WHITE); col(1, -2, 1, WHITE); col(2, -1, 1, WHITE);
    one(0, 0, -2, SPECK); one(2, 0, -2, SPECK2);
    one(0, 1, 2, CREAM);
    one(0, -1, 0, UNDER); one(1, -1, 0, UNDER);
  } else {
    // tip: chord 3 -> 2 -> 1
    col(0, -1, 1, WHITE); col(1, -1, 0, WHITE); col(2, 0, 0, SPECK2);
    one(0, 0, -1, SPECK2); one(1, 0, -1, SPECK2);
  }
  // faint frost glimmer on the ice-blue speckles — ice, not neon
  m.markEmissive(SPECK, 0.25);
  m.markEmissive(SPECK2, 0.35);
  const mesh = m.build(0.1, false);
  mesh.position.y = -0.05;
  return mesh;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  // --- torso: plump snowy chest with ice-blue speckles -------------------
  const torso = new VoxelModel();
  torso.ellipsoid(0, 3, 0, 2.6, 2.7, 2.3, WHITE);
  // cream belly patch
  torso.set(0, 2, 2, CREAM); torso.set(1, 3, 2, CREAM); torso.set(-1, 3, 2, CREAM);
  torso.set(0, 3, 2, CREAM); torso.set(0, 1, 2, CREAM);
  // speckles across back and shoulders
  torso.set(0, 5, 1, SPECK); torso.set(1, 5, -1, SPECK); torso.set(-1, 5, 0, SPECK2);
  torso.set(2, 4, 0, SPECK); torso.set(-2, 4, -1, SPECK2); torso.set(0, 4, 2, SPECK);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.28, 0);
  body.add(torsoMesh);

  // --- head: round skull + flat heart-shaped facial disc -----------------
  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  const head = new VoxelModel();
  head.ellipsoid(0, 2, -0.2, 2.6, 2.3, 2.2, WHITE);
  // face plate (z = 2): heart-shaped disc rim, big amber eyes, tiny beak
  head.set(-2, 4, 2, DISC); head.set(-1, 4, 2, DISC); head.set(0, 4, 2, WHITE);
  head.set(1, 4, 2, DISC); head.set(2, 4, 2, DISC);
  // Eyes: white sclera sits directly above each pupil (and the white center
  // column flanks it) so the amber shrinks to an outer iris rim instead of a
  // goggle band across the face.
  head.set(-2, 3, 2, EYE); head.set(-1, 3, 2, SCLERA); head.set(0, 3, 2, WHITE);
  head.set(1, 3, 2, SCLERA); head.set(2, 3, 2, EYE);
  head.set(-2, 2, 2, EYE); head.set(-1, 2, 2, PUPIL); head.set(0, 2, 2, WHITE);
  head.set(1, 2, 2, PUPIL); head.set(2, 2, 2, EYE);
  head.set(-2, 1, 2, DISC); head.set(-1, 1, 2, WHITE); head.set(0, 1, 2, BEAK);
  head.set(1, 1, 2, WHITE); head.set(2, 1, 2, DISC);
  head.set(-1, 0, 2, DISC); head.set(0, 0, 2, DISC); head.set(1, 0, 2, DISC);
  head.set(0, 1, 3, BEAK); // beak tip
  // crown speckles
  head.set(1, 4, 0, SPECK); head.set(-1, 4, 0, SPECK2); head.set(0, 4, -1, SPECK);
  const headMesh = head.build(0.1, true);
  headMesh.position.set(0, -0.08, 0);
  headGroup.add(headMesh);

  // --- wings: three hinged sections per side -----------------------------
  const mkWing = (sign: number): [THREE.Group, THREE.Group, THREE.Group] => {
    const rootG = new THREE.Group();
    rootG.position.set(sign * 0.24, 0.06, 0.0);
    rootG.add(wingSectionMesh(sign, 'inner'));
    const midG = new THREE.Group();
    midG.position.set(sign * 0.28, 0, 0);
    midG.add(wingSectionMesh(sign, 'mid'));
    rootG.add(midG);
    const tipG = new THREE.Group();
    tipG.position.set(sign * 0.28, 0, 0);
    tipG.add(wingSectionMesh(sign, 'tip'));
    midG.add(tipG);
    body.add(rootG);
    return [rootG, midG, tipG];
  };
  const [wingR, wingRMid, wingRTip] = mkWing(1);
  const [wingL, wingLMid, wingLTip] = mkWing(-1);

  // --- tail fan ----------------------------------------------------------
  const tailGroup = new THREE.Group();
  tailGroup.position.set(0, -0.14, -0.18);
  body.add(tailGroup);
  const tail = new VoxelModel();
  for (let z = -3; z <= 0; z++) tail.set(0, 0, z, WHITE);
  for (let z = -2; z <= 0; z++) { tail.set(1, 0, z, WHITE); tail.set(-1, 0, z, WHITE); }
  for (let z = -1; z <= 0; z++) { tail.set(2, 0, z, WHITE); tail.set(-2, 0, z, WHITE); }
  tail.set(0, 0, -3, SPECK); tail.set(1, 0, -2, CREAM); tail.set(-1, 0, -2, CREAM);
  const tailMesh = tail.build(0.1, true);
  tailMesh.position.set(0, -0.05, -0.16);
  tailGroup.add(tailMesh);

  // --- little talon feet -------------------------------------------------
  const mkLeg = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.09, -0.24, 0.03);
    const foot = new VoxelModel();
    foot.box(0, 0, 0, 1, 0, 1, TALON);
    foot.set(0, 0, 2, BEAK); foot.set(1, 0, 2, BEAK); // front claws
    const footMesh = foot.build(0.1, true);
    footMesh.position.set(0, -0.12, 0.02);
    g.add(footMesh);
    body.add(g);
    return g;
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  return {
    root,
    parts: {
      body, head: headGroup, tail: tailGroup,
      wingL, wingLMid, wingLTip, wingR, wingRMid, wingRTip,
      legL, legR,
    },
    height: 0.92,
    radius: 0.45,
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** fold: 0 = spread, 1 = folded against body. up > 0 raises wings. */
function poseWings(P: Parts, fold: number, up: number, midUp: number, tipUp: number): void {
  const sweep = 1.0 * fold;
  const droop = 0.24 * fold;
  P.wingL.rotation.set(0, -sweep, droop - up);
  P.wingR.rotation.set(0, sweep, -droop + up);
  P.wingLMid.rotation.set(0, -0.55 * fold, -midUp);
  P.wingRMid.rotation.set(0, 0.55 * fold, midUp);
  P.wingLTip.rotation.set(0, -0.5 * fold, -tipUp);
  P.wingRTip.rotation.set(0, 0.5 * fold, tipUp);
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const P = rig.parts;
  const t = ctx.time, at = ctx.actionTime, ms = ctx.moveSpeed;

  // Absolute base pose every frame (branches then layer motion on top).
  P.body.position.set(0, BODY_Y, 0);
  P.body.rotation.set(0, 0, 0);
  P.body.scale.set(1, 1, 1);
  P.head.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  P.head.rotation.set(0, 0, 0);
  P.tail.rotation.set(0.15, 0, 0);
  P.legL.rotation.set(0, 0, 0);
  P.legR.rotation.set(0, 0, 0);

  switch (ctx.action) {
    case 'idle': {
      // Perched: soft breathing, folded wings, famously curious owl head.
      const br = Math.sin(t * 1.7);
      P.body.scale.set(1 - br * 0.008, 1 + br * 0.022, 1 - br * 0.008);
      P.body.position.y = BODY_Y + br * 0.006;
      const ruffle = Math.pow(Math.max(0, Math.sin(t * 0.21 + 1.3)), 24);
      poseWings(P, 1 - 0.25 * ruffle,
        0.025 * br + 0.16 * ruffle * Math.sin(t * 26),
        0.06 * ruffle * Math.sin(t * 26 - 0.5),
        0.09 * ruffle * Math.sin(t * 26 - 1.0));
      P.head.rotation.set(
        0.05 * Math.sin(t * 1.7 + 0.6),
        0.7 * Math.tanh(2.2 * Math.sin(t * 0.42)),   // dwell-and-swivel scan
        0.16 * Math.sin(t * 0.83 + 1.7));            // charming side tilt
      P.tail.rotation.set(0.15 + 0.03 * br, 0.08 * Math.sin(t * 0.9), 0);
      P.legL.rotation.x = 0.02 * br;
      P.legR.rotation.x = -0.02 * br;
      break;
    }

    case 'walk': {
      // Ground travel = a bouncy sparrow-hop waddle.
      const ph = t * 6.5;
      const hop = Math.max(0, Math.sin(ph));
      const land = 1 - hop;
      P.body.position.y = BODY_Y + hop * 0.06;
      P.body.scale.set(1 + 0.045 * land, 1 - 0.09 * land, 1 + 0.045 * land);
      P.body.rotation.set(0.08 * hop, 0, 0.05 * Math.sin(ph * 0.5));
      P.legL.rotation.x = 0.55 * Math.sin(ph);
      P.legR.rotation.x = 0.55 * Math.sin(ph + Math.PI);
      poseWings(P, 0.55, 0.12 * hop + 0.10 * Math.sin(ph + 0.5),
        0.08 * Math.sin(ph), 0.10 * Math.sin(ph - 0.4));
      P.head.rotation.set(0.10 - 0.12 * hop, 0.1 * Math.sin(t * 0.9), 0.05 * Math.sin(ph * 0.5));
      P.tail.rotation.set(0.2 + 0.15 * hop, 0.15 * Math.sin(ph), 0);
      break;
    }

    case 'run': {
      // Fast travel: skimming powered flight low over the ground.
      const ph = t * 8.5;
      const amp = 0.5 + 0.15 * ms;
      poseWings(P, 0,
        Math.sin(ph) * amp + 0.06,
        Math.sin(ph - 0.55) * amp * 0.8,
        Math.sin(ph - 1.1) * amp * 0.95);
      P.body.rotation.set(0.28, 0, 0.08 * Math.sin(t * 1.1));
      P.body.position.y = BODY_Y + Math.sin(ph - 0.95) * 0.05;
      P.head.rotation.set(-0.18, 0.06 * Math.sin(t * 1.3), -0.06 * Math.sin(t * 1.1));
      P.tail.rotation.set(-0.1 + 0.07 * Math.sin(ph - 1.3), 0, 0.05 * Math.sin(t * 1.1));
      P.legL.rotation.x = 1.15;
      P.legR.rotation.x = 1.15;
      break;
    }

    case 'fly':
    case 'swim': {
      // Slow, powerful flaps alternating with long glides; head stays level.
      const g = smooth((Math.sin(t * 0.33) + 1) * 0.7 - 0.2); // glide mix, dwells at ends
      const ph = t * (3.6 + 2.6 * ms);
      const amp = (0.16 + 0.44 * (0.35 + 0.65 * ms)) * (1 - 0.82 * g);
      poseWings(P, 0,
        Math.sin(ph) * amp + 0.18 * g + 0.06,
        Math.sin(ph - 0.55) * amp * 0.8 + 0.10 * g,
        Math.sin(ph - 1.1) * amp * 0.95 + 0.05 * Math.sin(t * 7.3) * g);
      const bank = Math.sin(t * 0.55) * (0.06 + 0.10 * g);
      const pitch = 0.16 + 0.12 * ms - 0.06 * Math.sin(ph - 0.9) * (1 - g);
      P.body.rotation.set(pitch, 0, bank);
      P.body.position.y = BODY_Y + Math.sin(ph - 0.95) * 0.05 * (1 - g) + Math.sin(t * 1.15) * 0.025 * g;
      P.head.rotation.set(-pitch * 0.55, Math.sin(t * 0.7) * 0.12, -bank * 0.7); // gyro-stable owl head
      P.tail.rotation.set(-0.12 + 0.07 * Math.sin(ph - 1.3) * (1 - g) + 0.05 * g, 0, bank * 0.5);
      P.legL.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.1);
      P.legR.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.3);
      break;
    }

    case 'attack': {
      // Rear back with raised wings, then a snapping talon-and-beak strike.
      const wind = bump(at, 0.0, 0.30, 0.55);
      const strike = bump(at, 0.14, 0.55, 0.3);
      poseWings(P, 0.15,
        0.5 * wind - 0.5 * strike + 0.05 * Math.sin(t * 18),
        0.35 * wind - 0.3 * strike,
        0.3 * wind - 0.35 * strike);
      P.body.rotation.x = -0.15 * wind + 0.3 * strike;
      P.body.position.z = -0.05 * wind + 0.14 * strike;
      P.body.position.y = BODY_Y + 0.04 * wind - 0.03 * strike;
      P.head.rotation.x = -0.5 * wind + 0.85 * strike;
      P.head.position.z = HEAD_Z - 0.03 * wind + 0.10 * strike;
      P.head.position.y = HEAD_Y + 0.02 * wind - 0.04 * strike;
      P.tail.rotation.x = 0.15 + 0.3 * wind - 0.2 * strike;
      P.legL.rotation.x = 0.2 * wind - 0.7 * strike;
      P.legR.rotation.x = 0.2 * wind - 0.7 * strike;
      break;
    }

    case 'cast': {
      // Majestic rear-up: wings spread wide and high, tips shimmering.
      const rise = smooth(at / 0.5);
      const shimmer = Math.sin(t * 9) * 0.06 * rise;
      poseWings(P, 1 - rise,
        0.6 * rise + 0.1 * Math.sin(t * 2.6) * rise,
        0.35 * rise + shimmer,
        0.3 * rise + shimmer * 1.5);
      P.body.position.y = BODY_Y + 0.10 * rise + 0.02 * Math.sin(t * 3.1);
      P.body.rotation.x = -0.18 * rise;
      P.head.rotation.set(-0.28 * rise + 0.04 * Math.sin(t * 3.1), 0.06 * Math.sin(t * 1.9), 0);
      P.tail.rotation.set(0.5 * rise, 0.04 * Math.sin(t * 3.1), 0);
      P.legL.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.4);
      P.legR.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.6);
      break;
    }

    case 'special': {
      // Full flourish: wings sweep to a peak, slam down, then a shimmering hold.
      const gather = bump(at, 0, 0.5, 0.7);
      const slam = bump(at, 0.35, 0.8, 0.25);
      const after = smooth((at - 0.6) / 0.3);
      const shimmer = Math.sin(t * 16) * 0.12 * after * decay(at - 0.6, 1.2);
      poseWings(P, 0,
        1.05 * gather - 1.0 * slam + 0.4 * after + shimmer,
        0.6 * gather - 0.6 * slam + 0.25 * after + shimmer * 1.3,
        0.5 * gather - 0.7 * slam + 0.2 * after + shimmer * 1.6);
      P.body.position.y = BODY_Y - 0.06 * gather + 0.22 * slam + 0.08 * after;
      P.body.rotation.set(-0.2 * gather + 0.15 * slam, 0, 0.12 * Math.sin(at * 7) * slam);
      P.head.rotation.set(-0.35 * gather - 0.15 * after, 0, 0.1 * Math.sin(at * 7) * slam);
      P.tail.rotation.set(0.45 * gather + 0.3 * after, 0.08 * Math.sin(t * 5) * after, 0);
      P.legL.rotation.x = 0.3 * gather - 0.4 * slam;
      P.legR.rotation.x = 0.3 * gather - 0.4 * slam;
      break;
    }

    case 'hurt': {
      const sh = decay(at, 6);
      const jit = Math.sin(at * 46);
      P.body.position.set(0.035 * jit * sh, BODY_Y - 0.03 * sh, -0.05 * sh);
      P.body.rotation.set(-0.12 * sh, 0, 0.08 * jit * sh);
      poseWings(P, 0.5, -0.3 * sh + 0.08 * jit * sh, -0.2 * sh, -0.15 * sh);
      P.head.rotation.set(-0.15 * sh, 0.25 * Math.sin(at * 30) * sh, 0.1 * jit * sh);
      P.tail.rotation.set(0.15 - 0.2 * sh, 0.1 * jit * sh, 0);
      P.legL.rotation.x = 0.3 * sh;
      P.legR.rotation.x = 0.3 * sh;
      break;
    }

    case 'happy': {
      // Delighted bouncing, fluttery half-open wings, big head tilts.
      const ph = at * 9;
      const b = Math.abs(Math.sin(ph));
      const land = 1 - b;
      P.body.position.y = BODY_Y + 0.08 * b;
      P.body.scale.set(1 + 0.05 * land, 1 - 0.09 * land, 1 + 0.05 * land);
      P.body.rotation.set(-0.05 * b, 0.2 * Math.sin(at * 3.1), 0.05 * Math.sin(ph));
      poseWings(P, 0.3,
        0.25 * b + 0.28 * Math.abs(Math.sin(at * 14)),
        0.2 * Math.sin(at * 14 - 0.4),
        0.25 * Math.sin(at * 14 - 0.8));
      P.head.rotation.set(-0.1 * b, 0.3 * Math.sin(at * 2.2), 0.35 * Math.sin(at * 4.5));
      P.tail.rotation.set(0.3 + 0.2 * b, 0.35 * Math.sin(at * 8), 0);
      P.legL.rotation.x = 0.3 * Math.sin(at * 12);
      P.legR.rotation.x = 0.3 * Math.sin(at * 12 + Math.PI);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'frostwing',
  name: 'Frostwing',
  element: 'ice',
  locomotion: 'flying',
  description:
    'A snowy owl born in the heart of a glacier. It drifts on silent wings, '
    + 'watching everything with polite, unblinking curiosity, and its speckles '
    + 'glitter like fresh frost at dawn.',
  baseStats: { maxHp: 44, attack: 13, defense: 7, speed: 6.5 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
