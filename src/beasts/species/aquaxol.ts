import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// Aquaxol — smiling amphibious axolotl with streamer gills. Voxel scale 0.1
// (1 cell = 10 cm), faces +Z, root at ground/water level. Undulates to swim,
// waddles on its belly ashore.

const S = 0.1;

const AQUA = 0x79d4e4;
const AQUA_LIT = 0xa8ecf5;
const AQUA_DEEP = 0x4a9db8;
const BELLY = 0xd8f4f2;
const GILL = 0xf29391;
const GILL_TIP = 0xffc2ae;
const FIN = 0xb5e9f0;
const IRIS = 0x14323f;
const SHINE = 0xf4ffff;
const MOUTH = 0x33566b;
const BLUSH = 0xf7b0a4;

// Must match buildRig
const BODY_Y = 0.24;
const HEAD_Y = 0.1;
// 0.26, not 0.32: at 0.32 the skull is cantilevered ahead of the shoulders and covers
// the whole chest head-on.
const HEAD_Z = 0.26;
// Gill frond fan: base lift (rotZ) and back-sweep (rotY) per frond, front to back.
const GZ: readonly number[] = [0.55, 0.38, 0.2];
const GY: readonly number[] = [0.25, 0.5, 0.75];
const GR = ['gillR1', 'gillR2', 'gillR3'] as const;
const GL = ['gillL1', 'gillL2', 'gillL3'] as const;
const LEG_SPLAY = 0.3;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// Cycle slots — see BeastAnimCtx.cycle(). Every frequency here moves with the gait
// blend, so multiplying it into the session clock teleported the pose on a pace change.
const GAIT = 0;
const FROND = 1;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2.2, 0, 3.4, 2.6, 3.6, AQUA);
  m.ellipsoid(0, 0.9, 0, 3.0, 1.5, 3.2, BELLY);
  m.box(0, 5, -2, 0, 5, 2, FIN);
  m.box(0, 6, -1, 0, 6, 1, FIN);
  m.set(2, 3, 1, AQUA_DEEP);
  m.set(-2, 3, -1, AQUA_DEEP);
  m.set(1, 4, 0, AQUA_DEEP);
  m.set(-1, 4, 0, AQUA_DEEP);
  shadeUnder(m, AQUA_DEEP, -3, 3, 0, 2, -4, 4);
  rimTop(m, AQUA_LIT, -3, 3, 2, 5, -4, 4);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, 1, 2.4, 1.9, 2.0, AQUA);
  m.ellipsoid(0, 0.4, 1.6, 2.0, 1.0, 1.5, BELLY);
  m.box(-2, 1, 3, 2, 4, 3, AQUA);   // plate after the chin, so the chin shows only underneath
  rimTop(m, AQUA_LIT, -2, 2, 0, 5, -2, 3);
  // Pale field first, smile on top: the other order erased the smile's centre cell.
  for (let x = -2; x <= 2; x++) { m.set(x, 0, 3, BELLY); m.set(x, 1, 3, BELLY); }
  m.set(0, 0, 3, MOUTH);
  m.set(1, 1, 3, MOUTH); m.set(-1, 1, 3, MOUTH);
  eyes2x2(m, {
    // inner: 1, not 2 — at 2 the single column sits on the plate's outer edge and the
    // near eye is swallowed by the skull's own silhouette. lid in mid AQUA, not
    // AQUA_DEEP, which merged with the dark iris into one band in shade.
    inner: 1, width: 1, y: 2, faceZ: 3, iris: IRIS, shine: SHINE,
    lid: AQUA, bridge: BELLY, cheek: BLUSH,
  });
  return m.build(S, true);
}

function makeFrond(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, GILL);
  m.set(dir * 1, 0, 0, GILL);
  m.set(dir * 2, 0, 0, GILL);
  m.set(dir * 3, 0, 0, GILL_TIP);
  m.set(dir * 1, 0, 1, GILL_TIP);
  m.set(dir * 2, 0, -1, GILL_TIP);
  return m.build(S, false);
}

function makeLeg(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 1, 1, AQUA);
  m.set(0, 0, 2, BELLY);
  m.set(1, 0, 2, BELLY);
  return m.build(S, true);
}

function makeTailStem(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.5, -1.4, 1.4, 1.5, 1.9, AQUA);
  return m.build(S, true);
}

function makeTailPaddle(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, -1.8, 0.7, 2.6, 2.4, FIN);
  m.ellipsoid(0, 2, -1.5, 0.8, 1.7, 1.7, AQUA);
  return m.build(S, true);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.14, 0);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  // 0.05, not 0.10: build() re-centres on the bounding box, so a shorter model would
  // otherwise creep forward off the shoulders.
  headMesh.position.set(0, -0.14, 0.05);
  head.add(headMesh);

  const gills: Record<string, THREE.Group> = {};
  const gz = [0.06, -0.04, -0.12];
  const gy = [0.26, 0.24, 0.2];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Group();
    r.position.set(0.16, gy[i], gz[i]); // a cell INSIDE the skull, so no pose opens a gap
    r.rotation.set(0, GY[i], GZ[i]);
    head.add(r);
    r.add(makeFrond(1));
    gills[GR[i]] = r;

    const l = new THREE.Group();
    l.position.set(-0.16, gy[i], gz[i]);
    l.rotation.set(0, -GY[i], -GZ[i]);
    head.add(l);
    const lFrond = makeFrond(-1);
    lFrond.position.x = -0.1; // mirrors the center=false voxel-grid pivot offset
    l.add(lFrond);
    gills[GL[i]] = l;
  }

  const mkLegGroup = (x: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.04, z);
    g.rotation.z = x > 0 ? LEG_SPLAY : -LEG_SPLAY;
    body.add(g);
    const mesh = makeLeg();
    mesh.position.set(0, -0.2, 0);
    g.add(mesh);
    return g;
  };
  const legFL = mkLegGroup(0.26, 0.24);
  const legFR = mkLegGroup(-0.26, 0.24);
  const legBL = mkLegGroup(0.26, -0.22);
  const legBR = mkLegGroup(-0.26, -0.22);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, 0.02, -0.26);
  body.add(tailBase);
  const stem = makeTailStem();
  stem.position.set(0, -0.1, -0.1);
  tailBase.add(stem);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0.02, -0.28);
  tailBase.add(tailTip);
  const paddle = makeTailPaddle();
  paddle.position.set(0, -0.18, -0.08);
  tailTip.add(paddle);

  return {
    root,
    parts: {
      body, head, legFL, legFR, legBL, legBR, tailBase, tailTip,
      gillR1: gills.gillR1, gillR2: gills.gillR2, gillR3: gills.gillR3,
      gillL1: gills.gillL1, gillL2: gills.gillL2, gillL3: gills.gillL3,
    },
    height: 0.76,
    radius: 0.48,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.1);

  let bpx = 0, bpy = BODY_Y + 0.004 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.012 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0, hpy = HEAD_Y, hpz = HEAD_Z;
  let flrx = 0, frrx = 0, blrx = 0, brrx = 0, legSplayMul = 1;
  let tbx = 0, tby = 0, ttx = 0, tty = 0;
  let gillFlare = 0, gillBack = 0, gillWaveAmp = 0.1, gillFreq = 1.8, gillSweepAmp = 0.06, gillPhase = 0;

  switch (ctx.action) {
    case 'idle': {
      bsy = 1 + 0.028 * br;
      bsx = bsz = 1 - 0.012 * br;
      hrx = 0.05 * Math.sin(t * 1.5 + 0.4);
      hry = 0.08 * Math.sin(t * 0.23);
      hrz = 0.04 * Math.sin(t * 0.7) + 0.22 * Math.max(0, Math.sin(t * 0.31 + 2.1)) ** 12;
      gillWaveAmp = 0.14;
      gillFlare = 0.25 * Math.max(0, Math.sin(t * 0.5 + 2)) ** 10;
      tby = 0.15 * Math.sin(t * 1.3);
      tty = 0.2 * Math.sin(t * 1.3 - 0.9);
      flrx = 0.08 * Math.sin(t * 1.9);
      brrx = 0.08 * Math.sin(t * 1.9 + 2);
      break;
    }
    case 'walk':
    case 'run': {
      const isRun = ctx.action === 'run';
      // Integrated: as `t * f` the spin-up put 1.69 rad of leg swing in one frame
      // (tools/test-beastanim.mjs); the integrated cycle peaks at 0.29.
      const f = (isRun ? 8 : 5.5) + 3 * ms;
      const ph = ctx.cycle(GAIT, f);
      const amp = (isRun ? 0.9 : 0.65) * (0.5 + 0.5 * ms);
      brz = (isRun ? 0.17 : 0.13) * Math.sin(ph);
      bry = 0.09 * Math.sin(ph - 0.4);
      bpy += 0.02 * Math.sin(ph * 2) + (isRun ? 0.035 * Math.max(0, Math.sin(ph * 2 + 0.5)) : 0);
      bsy = 1 + 0.04 * Math.sin(ph * 2 + 0.8);
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      flrx = brrx = amp * Math.sin(ph);
      frrx = blrx = amp * Math.sin(ph + Math.PI);
      hrz = -0.1 * Math.sin(ph);
      hrx = 0.05 * Math.sin(ph * 2) - 0.04 * ms;
      tby = 0.4 * Math.sin(ph - 1.0);
      tty = 0.55 * Math.sin(ph - 1.7);
      gillWaveAmp = 0.24;
      gillFreq = f;
      gillPhase = -1.2;
      gillSweepAmp = 0.1;
      break;
    }
    case 'swim':
    case 'fly': {
      const f = 4.5 + 3.5 * ms;
      const ph = ctx.cycle(GAIT, f);
      bry = 0.1 * Math.sin(ph);
      brz = 0.07 * Math.sin(ph - 0.6);
      brx = 0.03 + 0.04 * Math.sin(t * 1.5);
      bpy += 0.03 * Math.sin(t * 2.1);
      tby = 0.5 * Math.sin(ph - 0.9);
      tty = 0.7 * Math.sin(ph - 1.7);
      legSplayMul = 0.3;
      flrx = 1.0 + 0.15 * Math.sin(ph * 2);
      frrx = 1.0 + 0.15 * Math.sin(ph * 2 + 1.2);
      blrx = 1.0 + 0.15 * Math.sin(ph * 2 + 2.4);
      brrx = 1.0 + 0.15 * Math.sin(ph * 2 + 3.6);
      hrx = 0.05 * Math.sin(ph - 0.4);
      hry = 0.08 * Math.sin(ph + 0.5);
      gillBack = 0.45;
      gillWaveAmp = 0.26;
      gillFreq = f;
      gillSweepAmp = 0.16;
      break;
    }
    case 'attack': {
      const wind = smooth(phase(at, 0, 0.14));
      const lunge = ezOut(phase(at, 0.14, 0.3));
      const rec = smooth(phase(at, 0.45, 0.8));
      const k = -0.6 * wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.18 * k;
      bpy += 0.02 * kp;
      brx = 0.1 * k;
      bsz = 1 + 0.15 * kp;
      bsx = 1 - 0.06 * kp;
      hrx = 0.25 * k;
      hpz = HEAD_Z + 0.07 * kp;
      gillFlare = 0.6 * kp;
      gillBack = 0.3 * wind * (1 - lunge);
      flrx = frrx = -0.5 * kp + 0.4 * wind * (1 - lunge);
      blrx = brrx = 0.5 * kp;
      tby = -0.35 * k;
      tty = -0.45 * k;
      break;
    }
    case 'cast': {
      const rise = ezOut(clamp01(at / 0.4));
      const tremor = 0.5 * Math.sin(t * 12) + 0.5 * Math.sin(t * 17);
      brx = -0.45 * rise + 0.02 * tremor * rise;
      bpy += 0.08 * rise;
      hrx = 0.28 * rise;
      flrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5) * rise;
      frrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5 + Math.PI) * rise;
      blrx = brrx = 0.4 * rise;
      tbx = -0.3 * rise;
      tby = 0.06 * Math.sin(t * 8);
      gillFlare = 0.7 * rise;
      gillWaveAmp = 0.1 + 0.3 * rise;
      gillFreq = 9;
      break;
    }
    case 'special': {
      const T = 0.8;
      const k2 = clamp01(at / T);
      const tuck = Math.sin(Math.PI * k2);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.22)) * (1 - smooth(phase(at, T + 0.22, T + 0.55)));
      brz = Math.PI * 2 * smooth(k2);
      bpy += 0.22 * tuck;
      bsy = 1 - 0.2 * land;
      bsx = bsz = 1 + 0.11 * land;
      hrx = -0.15 * tuck + 0.1 * land;
      flrx = frrx = -0.6 * tuck + 0.3 * land;
      blrx = brrx = 0.8 * tuck - 0.3 * land;
      tby = 0.6 * Math.sin(at * 14) * tuck;
      tty = 0.8 * Math.sin(at * 14 - 0.7) * tuck;
      gillFlare = 0.9 * tuck + 0.3 * land;
      gillWaveAmp = 0.3;
      gillFreq = 10;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.5 * at);
      bpx = 0.035 * Math.sin(at * 42) * d;
      bpy -= 0.04 * d;
      bpz = -0.08 * d;
      brz = 0.07 * Math.sin(at * 35 + 1) * d;
      hrx = -0.2 * d;
      hrz = 0.08 * Math.sin(at * 28) * d;
      gillFlare = -0.45 * d;
      gillBack = 0.5 * d;
      flrx = frrx = 0.25 * d;
      blrx = brrx = -0.25 * d;
      tbx = 0.3 * d;
      bsy = 1 - 0.08 * d;
      bsx = bsz = 1 + 0.04 * d;
      break;
    }
    case 'happy': {
      const hf = 5;
      const hop = Math.abs(Math.sin(at * hf));
      bpy += 0.1 * hop;
      bsy = 0.88 + 0.24 * hop;
      bsx = bsz = 1 - 0.5 * (bsy - 1);
      bry = 0.3 * Math.sin(at * 2.4);
      hrz = 0.25 * Math.sin(at * 2.4 + 1);
      hrx = -0.08;
      flrx = 0.3 * Math.sin(at * 10);
      frrx = 0.3 * Math.sin(at * 10 + Math.PI);
      blrx = 0.3 * Math.sin(at * 10 + 1.5);
      brrx = 0.3 * Math.sin(at * 10 + 1.5 + Math.PI);
      tby = 0.6 * Math.sin(at * 13);
      tty = 0.8 * Math.sin(at * 13 - 0.7);
      gillFlare = 0.3 + 0.2 * Math.sin(at * 5);
      gillWaveAmp = 0.35;
      gillFreq = 11;
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, hpy, hpz);
  p.head.rotation.set(hrx, hry, hrz);
  p.legFL.rotation.set(flrx, 0, LEG_SPLAY * legSplayMul);
  p.legFR.rotation.set(frrx, 0, -LEG_SPLAY * legSplayMul);
  p.legBL.rotation.set(blrx, 0, LEG_SPLAY * legSplayMul);
  p.legBR.rotation.set(brrx, 0, -LEG_SPLAY * legSplayMul);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailTip.rotation.set(ttx, tty, 0);

  // Mirrored fan, each frond on its own ripple phase. The sweep is a constant 0.8x of
  // the integrated phase, which keeps the rate ratio exact and continuous.
  const gw = ctx.cycle(FROND, gillFreq);
  for (let i = 0; i < 3; i++) {
    const lift = GZ[i] + gillFlare + gillWaveAmp * Math.sin(gw + gillPhase + i * 0.9);
    const sweep = GY[i] + gillBack + gillSweepAmp * Math.sin(gw * 0.8 + i * 0.7);
    p[GR[i]].rotation.set(0, sweep, lift);
    p[GL[i]].rotation.set(0, -sweep, -lift);
  }
}

export const skills: SkillDef[] = [
  {
    id: 'aquaxol.bubble-pop',
    nameKey: 'skill.aquaxol.bubble-pop.name',
    descriptionKey: 'skill.aquaxol.bubble-pop.desc',
    element: 'water',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.6,
    power: 10,
    range: 14,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'aquaxol.tide-swirl',
    nameKey: 'skill.aquaxol.tide-swirl.name',
    descriptionKey: 'skill.aquaxol.tide-swirl.desc',
    element: 'water',
    targeting: 'aoe',
    cost: 12,
    cooldown: 5,
    power: 17,
    range: 3.8,
    learnAtLevel: 4,
    castAnim: 'cast',
  },
  {
    id: 'aquaxol.soothing-slime',
    nameKey: 'skill.aquaxol.soothing-slime.name',
    descriptionKey: 'skill.aquaxol.soothing-slime.desc',
    element: 'water',
    targeting: 'support',
    cost: 16,
    cooldown: 8,
    power: 22,
    range: 6,
    storePrice: 220,
    castAnim: 'special',
  },
  {
    id: 'aquaxol.hydro-jet',
    nameKey: 'skill.aquaxol.hydro-jet.name',
    descriptionKey: 'skill.aquaxol.hydro-jet.desc',
    element: 'water',
    targeting: 'beam',
    cost: 20,
    cooldown: 9,
    power: 32,
    range: 12,
    storePrice: 320,
    castAnim: 'cast',
  },
];

export const species: BeastSpecies = {
  id: 'aquaxol',
  nameKey: 'beast.aquaxol.name',
  element: 'water',
  locomotion: 'amphibious',
  descriptionKey: 'beast.aquaxol.desc',
  baseStats: { maxHp: 54, attack: 9, defense: 8, speed: 3.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
