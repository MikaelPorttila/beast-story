import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// Lanternfin — anglerfish, drawn for the deep sea (DEEP_WATER_DEPTH in world/terrain.ts).
// Voxel scale 0.1 (1 cell = 10 cm), faces +Z, root at water level. Fish, not mammal:
// the tail beats horizontally (rotY), the opposite of Finnick's fluke.

const S = 0.1;

const HIDE = 0x2c2a44;
const HIDE_LIT = 0x4e4a72;
const HIDE_DARK = 0x17162a;
const BELLY = 0x3d3a5c;
const FIN = 0x393555;
const FIN_EDGE = 0x6f68a0;
const TOOTH = 0xf3f6ff;
const MAW = 0x0c0b16;
const IRIS = 0x0f0e1c;
const SHINE = 0xdfe6ff;
const LURE = 0xa9f6ff;
const LURE_CORE = 0xffffff;
// 0.85, not setEmissive's 1.5 default: under bloom the cells bleed into one blob
// and the lamp stops reading as a point on a stalk.
const LURE_GLOW = 0.85;
const STALK = 0x3a3660;

// Must match buildRig
const BODY_Y = 0.40;
const HEAD_Z = 0.30;
const ROD_REST = -0.55;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// Cycle slots — see BeastAnimCtx.cycle().
const GAIT = 0;
const ROD = 1;
const FINS = 2;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2.8, 1.0, 3.2, 3.0, 3.6, HIDE);
  m.ellipsoid(0, 2.4, -2.6, 1.6, 1.8, 2.4, HIDE);
  m.ellipsoid(0, 1.4, 0.8, 2.6, 1.6, 3.0, BELLY);
  shadeUnder(m, HIDE_DARK, -4, 4, 0, 2, -5, 5);
  rimTop(m, HIDE_LIT, -4, 4, 3, 7, -5, 5);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2.6, 0, 3.4, 2.6, 2.8, HIDE);
  m.box(-3, 1, 3, 3, 5, 3, HIDE);
  // Maw band goes down BEFORE the teeth, or it erases its own row.
  m.box(-3, 0, 3, 3, 1, 3, MAW);
  m.box(-3, 0, 4, 3, 0, 4, MAW);
  for (let x = -3; x <= 3; x += 2) {
    m.set(x, 1, 4, TOOTH);
    m.set(x + 1, 0, 4, TOOTH);
  }
  rimTop(m, HIDE_LIT, -3, 3, 2, 6, -3, 3);
  eyes2x2(m, {
    inner: 1, width: 2, y: 3, faceZ: 3, iris: IRIS, shine: SHINE,
    lid: HIDE_DARK, bridge: HIDE_LIT, browProud: true,
  });
  return m.build(S, true);
}

/** The illicium; pivot at the base so it waves from the brow. */
function makeRod(): THREE.Mesh {
  const m = new VoxelModel();
  for (let i = 0; i < 4; i++) m.set(0, i, 0, STALK);
  // Region so the glow is one part, not five loose cells.
  m.region(() => {
    m.setEmissive(0, 5, 0, LURE, LURE_GLOW);
    m.setEmissive(-1, 5, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(1, 5, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(0, 6, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(0, 5, 1, LURE_CORE, LURE_GLOW);
  });
  return m.build(S, false);
}

function makeTail(): THREE.Mesh {
  const m = new VoxelModel();
  for (let y = -3; y <= 3; y++) {
    const reach = 3 - Math.floor(Math.abs(y) * 0.4);
    m.box(0, y + 3, -reach, 0, y + 3, 0, FIN);
    m.set(0, y + 3, -reach, FIN_EDGE);
  }
  return m.build(S, false);
}

function makeDorsal(): THREE.Mesh {
  const m = new VoxelModel();
  for (let z = -3; z <= 2; z++) {
    const h = 2 - Math.floor(Math.abs(z + 0.5) * 0.4);
    m.box(0, 0, z, 0, h, z, FIN);
    m.set(0, h, z, FIN_EDGE);
  }
  return m.build(S, false);
}

/** `dir` is +1 for the right side. */
function makePectoral(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  for (let i = 0; i <= 2; i++) {
    m.box(dir * i, 0, -i, dir * i, 1 - Math.floor(i * 0.5), 1, FIN);
  }
  m.set(dir * 2, 0, -2, FIN_EDGE);
  m.set(dir * 2, 1, 0, FIN_EDGE);
  return m.build(S, false);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.26, -0.06);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, 0.04, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.16, 0.02);
  head.add(headMesh);

  // Rod parents to the HEAD: on the torso it swings out from behind the skull on a turn.
  const rod = new THREE.Group();
  rod.position.set(0, 0.20, 0.10);
  rod.rotation.x = ROD_REST;
  head.add(rod);
  const rodMesh = makeRod();
  rodMesh.position.set(-0.05, 0, -0.05);
  rod.add(rodMesh);

  const dorsal = new THREE.Group();
  dorsal.position.set(0, 0.32, -0.14);
  body.add(dorsal);
  const dorsalMesh = makeDorsal();
  dorsalMesh.position.set(-0.05, 0, 0);
  dorsal.add(dorsalMesh);

  const mkPect = (dir: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(dir * 0.32, -0.10, 0.04);
    g.rotation.set(0, dir * -0.4, dir * -0.25);
    body.add(g);
    g.add(makePectoral(dir));
    return g;
  };
  const pectR = mkPect(1);
  const pectL = mkPect(-1);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, -0.02, -0.46);
  body.add(tailBase);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0, -0.22);
  tailBase.add(tailTip);
  const tailMesh = makeTail();
  tailMesh.position.set(-0.05, -0.30, 0);
  tailTip.add(tailMesh);

  return {
    root,
    parts: { body, head, rod, dorsal, pectR, pectL, tailBase, tailTip },
    height: 0.88,
    radius: 0.46,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 1.7);

  let bpx = 0, bpy = BODY_Y + 0.012 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsy = 1 + 0.014 * br;
  let hrx = 0, hry = 0, hrz = 0;
  let tby = 0, tbx = 0, tty = 0;
  let rodX = 0, rodY = 0, rodZ = 0;
  let pSweep = 0, pLift = 0;
  let dorsalTilt = 0;
  // Kept off every other frequency here so the lamp never nods in time with the tail.
  let rodAmp = 0.14, rodFreq = 1.3;

  switch (ctx.action) {
    case 'idle': {
      const hang = ctx.cycle(GAIT, 1.2);
      bsy = 1 + 0.026 * br;
      brx = 0.04 * Math.sin(hang);
      bpy += 0.03 * Math.sin(hang - 0.6);
      tby = 0.16 * Math.sin(hang);
      tty = 0.24 * Math.sin(hang - 0.8);
      hry = 0.12 * Math.sin(t * 0.21);
      hrx = 0.04 * Math.sin(t * 0.8);
      rodAmp = 0.22;
      rodFreq = 0.9;
      pSweep = 0.12 * Math.sin(ctx.cycle(FINS, 2.0));
      pLift = 0.08;
      dorsalTilt = 0.05 * Math.sin(t * 0.9);
      break;
    }
    case 'walk':
    case 'run': {
      // Out of water: too head-heavy to flop forward like Finnick, so it thrashes flat.
      const isRun = ctx.action === 'run';
      const f = (isRun ? 5.5 : 4.0) + 2.4 * ms;
      const ph = ctx.cycle(GAIT, f);
      const thrash = Math.sin(ph);
      brz = 0.42 * thrash;
      bry = 0.16 * Math.sin(ph * 0.5);
      bpy += 0.09 * Math.abs(thrash);
      bpx = 0.04 * Math.sin(ph * 0.5 - 0.6);
      bsy = 1 + 0.05 * Math.sin(ph * 2);
      hrz = -0.24 * thrash;
      hry = 0.14 * Math.sin(ph - 0.7);
      tby = 0.55 * Math.sin(ph - 0.6);
      tty = 0.70 * Math.sin(ph - 1.3);
      rodAmp = 0.45;
      rodFreq = f;
      rodZ = -0.30 * thrash;
      pSweep = 0.5 * Math.abs(thrash);
      pLift = -0.3 * Math.abs(thrash);
      dorsalTilt = 0.2 * thrash;
      break;
    }
    case 'swim':
    case 'fly': {
      const f = 2.8 + 3.4 * ms;
      const ph = ctx.cycle(GAIT, f);
      tby = (0.34 + 0.24 * ms) * Math.sin(ph);
      tty = (0.48 + 0.32 * ms) * Math.sin(ph - 0.9);
      bry = 0.10 * Math.sin(ph + 0.4);
      brz = 0.09 * Math.sin(ph * 0.4);
      bpy += 0.035 * Math.sin(ph * 0.5);
      brx = -0.03;
      hry = -0.07 * Math.sin(ph + 0.4);
      // Rod holds still while the body moves under it — bait that swings reads as attached.
      rodAmp = 0.10;
      rodFreq = 1.1;
      rodX = 0.06 * Math.sin(ph * 0.25);
      const pw = ctx.cycle(FINS, f * 0.5);
      pSweep = -0.08 + 0.14 * Math.sin(pw);
      pLift = 0.14 + 0.10 * Math.sin(pw - 0.5);
      dorsalTilt = 0.06 * Math.sin(ph * 0.4);
      break;
    }
    case 'attack': {
      // Rod snaps back out of the way: an angler does not eat its own lamp.
      const wind = smooth(phase(at, 0, 0.13));
      const lunge = ezOut(phase(at, 0.13, 0.26));
      const rec = smooth(phase(at, 0.4, 0.78));
      const k = -0.5 * wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.26 * k;
      brx = -0.14 * k;
      bpy += 0.04 * kp;
      hrx = 0.30 * k;
      rodX = -1.0 * kp - 0.3 * wind * (1 - lunge);
      rodAmp = 0.05;
      tby = -0.45 * k;
      tty = -0.60 * k;
      pSweep = -0.5 * kp + 0.45 * wind * (1 - lunge);
      pLift = 0.35 * kp;
      dorsalTilt = -0.18 * k;
      break;
    }
    case 'cast': {
      const rise = ezOut(clamp01(at / 0.4));
      const pulse = 0.5 * Math.sin(t * 12) + 0.5 * Math.sin(t * 18.5);
      brx = -0.28 * rise;
      bpy += 0.09 * rise;
      hrx = 0.16 * rise;
      rodX = 0.85 * rise + 0.06 * pulse * rise;
      rodAmp = 0.06 + 0.16 * rise;
      rodFreq = 8;
      tby = 0.12 * Math.sin(t * 3);
      tty = 0.18 * Math.sin(t * 3 - 0.8);
      pSweep = 0.4 * rise;
      pLift = -0.35 * rise + 0.10 * Math.sin(t * 6) * rise;
      dorsalTilt = 0.12 * Math.sin(t * 7) * rise;
      break;
    }
    case 'special': {
      // Spin about Y so the lamp traces its ring in the horizontal plane.
      const T = 0.85;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const settle = Math.sin(Math.PI * phase(at, T, T + 0.26))
        * (1 - smooth(phase(at, T + 0.26, T + 0.62)));
      bry = Math.PI * 4 * smooth(k2);
      bpy += 0.20 * spin;
      bsy = 1 - 0.12 * settle;
      brz = 0.30 * spin;
      rodX = 0.5 * spin;
      rodZ = 0.55 * spin;
      rodAmp = 0.30;
      rodFreq = 11;
      tby = 0.7 * Math.sin(at * 14) * spin;
      tty = 0.9 * Math.sin(at * 14 - 0.8) * spin;
      pSweep = -0.6 * spin + 0.3 * settle;
      pLift = 0.5 * spin;
      dorsalTilt = 0.28 * Math.sin(at * 10) * spin;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.6 * at);
      bpx = 0.04 * Math.sin(at * 42) * d;
      bpz = -0.08 * d;
      bpy -= 0.05 * d;
      brz = 0.12 * Math.sin(at * 34 + 1) * d;
      hrx = -0.24 * d;
      rodX = -0.9 * d;
      rodAmp = 0.04;
      tby = 0.4 * Math.sin(at * 30) * d;
      tty = 0.5 * Math.sin(at * 30 - 0.7) * d;
      pSweep = 0.3 * d;
      pLift = -0.3 * d;
      bsy = 1 - 0.08 * d;
      break;
    }
    case 'happy': {
      const hf = 4.5;
      const bob = Math.abs(Math.sin(at * hf));
      bpy += 0.14 * bob;
      bsy = 0.93 + 0.14 * bob;
      bry = 0.32 * Math.sin(at * 2.1);
      brz = 0.14 * Math.sin(at * 2.1 + 1);
      hrz = 0.18 * Math.sin(at * 2.1 + 0.7);
      rodX = 0.30 + 0.30 * Math.sin(at * hf);
      rodZ = 0.45 * Math.sin(at * hf * 0.5);
      rodAmp = 0.35;
      rodFreq = 9;
      tby = 0.45 * Math.sin(at * 9);
      tty = 0.60 * Math.sin(at * 9 - 0.8);
      pSweep = 0.35 * Math.sin(at * 8);
      pLift = 0.25 + 0.2 * Math.sin(at * 8);
      dorsalTilt = 0.16 * Math.sin(at * 5);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.head.rotation.set(hrx, hry, hrz);
  p.dorsal.rotation.set(0, 0, dorsalTilt);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailTip.rotation.set(0, tty, 0);
  p.pectR.rotation.set(0, -0.4 + pSweep, -0.25 - pLift);
  p.pectL.rotation.set(0, 0.4 - pSweep, 0.25 + pLift);

  // Own cycle slot so the wobble is never a harmonic of the tail beat.
  const rw = ctx.cycle(ROD, rodFreq);
  p.rod.rotation.set(
    ROD_REST + rodX + rodAmp * Math.sin(rw),
    rodY + rodAmp * 0.7 * Math.sin(rw * 0.6 + 1.3),
    rodZ + rodAmp * 0.5 * Math.sin(rw * 0.8 + 2.1),
  );
}

export const skills: SkillDef[] = [
  {
    id: 'lanternfin.glimmer-mote',
    nameKey: 'skill.lanternfin.glimmer-mote.name',
    descriptionKey: 'skill.lanternfin.glimmer-mote.desc',
    element: 'light',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.5,
    power: 12,
    range: 15,
    learnAtLevel: 1,
    castAnim: 'cast',
  },
  {
    id: 'lanternfin.abyss-bite',
    nameKey: 'skill.lanternfin.abyss-bite.name',
    descriptionKey: 'skill.lanternfin.abyss-bite.desc',
    element: 'shadow',
    targeting: 'melee',
    cost: 9,
    cooldown: 3.0,
    power: 20,
    range: 3.0,
    learnAtLevel: 4,
    castAnim: 'attack',
  },
  {
    id: 'lanternfin.lure-glow',
    nameKey: 'skill.lanternfin.lure-glow.name',
    descriptionKey: 'skill.lanternfin.lure-glow.desc',
    element: 'light',
    targeting: 'support',
    cost: 15,
    cooldown: 8.5,
    power: 22,
    range: 7,
    storePrice: 240,
    castAnim: 'cast',
  },
  {
    id: 'lanternfin.deep-pulse',
    nameKey: 'skill.lanternfin.deep-pulse.name',
    descriptionKey: 'skill.lanternfin.deep-pulse.desc',
    element: 'light',
    targeting: 'beam',
    cost: 21,
    cooldown: 9,
    power: 33,
    range: 13,
    storePrice: 330,
    castAnim: 'special',
  },
];

export const species: BeastSpecies = {
  id: 'lanternfin',
  nameKey: 'beast.lanternfin.name',
  descriptionKey: 'beast.lanternfin.desc',
  element: 'light',
  locomotion: 'swimming',
  // 17.9 u/s in water against Finnick's 21.8, 5.7 on land after LAND_FLOP.
  baseStats: { maxHp: 56, attack: 13, defense: 9, speed: 5.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
