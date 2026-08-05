import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Lanternfin — an anglerfish that came up out of the abyss with its lamp still
// lit. The species the DEEP SEA was drawn for (see DEEP_WATER_DEPTH in
// world/terrain.ts): a light-typed swimmer whose whole silhouette is a dark
// mass with one bright point in front of it, which is the one shape that reads
// against water the colour of ink.
//
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground /
// water level. Fish, not mammal — the tail beats HORIZONTALLY (rotY), which is
// the opposite of Finnick's fluke and the difference between the two rigs.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette. Almost the whole animal is within a few percent of one very dark
// blue-violet, and that is deliberate: the model has exactly two bright things
// on it (the lure and the teeth), and every cell of coat that competes with
// them costs the silhouette. The value range lives in the rim light.
const HIDE = 0x2c2a44;      // deep blue-violet body
const HIDE_LIT = 0x4e4a72;  // the one lit crest along the spine
const HIDE_DARK = 0x17162a;
const BELLY = 0x3d3a5c;     // barely lighter — this animal has no pale side
const FIN = 0x393555;
const FIN_EDGE = 0x6f68a0;  // translucent-looking fin rims
const TOOTH = 0xf3f6ff;     // the needle teeth
const MAW = 0x0c0b16;       // inside the mouth: the darkest cell on the model
const IRIS = 0x0f0e1c;
const SHINE = 0xdfe6ff;
/**
 * The lure. EMISSIVE, and the intensity is 0.85 rather than the 1.5 default
 * `setEmissive` offers: a bloom pass runs over this, and the whole point of the
 * lamp is that it is a POINT. At full intensity the four cells bleed into one
 * soft blob the size of the head and stop reading as a light on a stalk —
 * exactly the warning eyes2x2 gives about a glowing iris, on a bigger part.
 */
const LURE = 0xa9f6ff;
const LURE_CORE = 0xffffff;
const LURE_GLOW = 0.85;
const STALK = 0x3a3660;

// Base pose constants (must match buildRig)
const BODY_Y = 0.40;
const HEAD_Z = 0.30;
/** Rest angle of the lure stalk: arched up and forward over the brow. */
const ROD_REST = -0.55;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/** Integrated cycle slots — see BeastAnimCtx.cycle(). */
const GAIT = 0;   // the tail beat
const ROD = 1;    // the lure's own bob, which never matches the tail
const FINS = 2;   // pectoral flutter

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  // A TEARDROP POINTING BACKWARD: fattest right behind the head, tapering to a
  // thin wrist. An anglerfish is nearly all head, and drawing the body as a
  // uniform tube loses that in one step.
  m.ellipsoid(0, 2.8, 1.0, 3.2, 3.0, 3.6, HIDE);
  m.ellipsoid(0, 2.4, -2.6, 1.6, 1.8, 2.4, HIDE);      // the wrist
  m.ellipsoid(0, 1.4, 0.8, 2.6, 1.6, 3.0, BELLY);
  shadeUnder(m, HIDE_DARK, -4, 4, 0, 2, -5, 5);
  rimTop(m, HIDE_LIT, -4, 4, 3, 7, -5, 5);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // Seven cells across — the widest face in the roster, and the reason this one
  // can afford a two-cell eye where Aquaxol had to take one.
  m.ellipsoid(0, 2.6, 0, 3.4, 2.6, 2.8, HIDE);
  m.box(-3, 1, 3, 3, 5, 3, HIDE);                       // the face plate
  // The MAW: a wide dark band across the bottom of the face with a row of
  // needle teeth standing in it. The band is painted BEFORE the teeth so the
  // teeth survive; painted the other way round the mouth erased its own row and
  // came out as a plain dark slot.
  m.box(-3, 0, 3, 3, 1, 3, MAW);
  m.box(-3, 0, 4, 3, 0, 4, MAW);
  for (let x = -3; x <= 3; x += 2) {
    m.set(x, 1, 4, TOOTH);                              // upper fangs, proud
    m.set(x + 1, 0, 4, TOOTH);                          // lower, offset
  }
  rimTop(m, HIDE_LIT, -3, 3, 2, 6, -3, 3);
  eyes2x2(m, {
    inner: 1, width: 2, y: 3, faceZ: 3, iris: IRIS, shine: SHINE,
    lid: HIDE_DARK, bridge: HIDE_LIT, browProud: true,
  });
  return m.build(S, true);
}

/**
 * The illicium — the rod the lamp hangs from. Built with its pivot at the base
 * so the whole thing waves from the brow, and with the LAMP as its own bracket
 * so the emissive cells are contiguous.
 */
function makeRod(): THREE.Mesh {
  const m = new VoxelModel();
  for (let i = 0; i < 4; i++) m.set(0, i, 0, STALK);
  // Four emissive cells and one white core. Bracketed in a region so the glow
  // is one part of the model rather than five loose cells — the same thing the
  // town lamps do with GLOW_PART, for the same reason.
  m.region(() => {
    m.setEmissive(0, 5, 0, LURE, LURE_GLOW);
    m.setEmissive(-1, 5, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(1, 5, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(0, 6, 0, LURE, LURE_GLOW * 0.8);
    m.setEmissive(0, 5, 1, LURE_CORE, LURE_GLOW);
  });
  return m.build(S, false);
}

/** The tail fan — a tall vertical blade, which is what makes it a fish. */
function makeTail(): THREE.Mesh {
  const m = new VoxelModel();
  for (let y = -3; y <= 3; y++) {
    const reach = 3 - Math.floor(Math.abs(y) * 0.4);
    m.box(0, y + 3, -reach, 0, y + 3, 0, FIN);
    m.set(0, y + 3, -reach, FIN_EDGE);
  }
  return m.build(S, false);
}

/** The dorsal ridge — a low sail along the spine. */
function makeDorsal(): THREE.Mesh {
  const m = new VoxelModel();
  for (let z = -3; z <= 2; z++) {
    const h = 2 - Math.floor(Math.abs(z + 0.5) * 0.4);
    m.box(0, 0, z, 0, h, z, FIN);
    m.set(0, h, z, FIN_EDGE);
  }
  return m.build(S, false);
}

/** One pectoral fin. `dir` is +1 for the right side; painted, never scaled. */
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

  // The rod hangs off the HEAD, not the body: the lamp has to stay in front of
  // the mouth through every pose, and a rod parented to the torso swings out
  // from behind the skull the moment the head turns.
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
  // The lure's own idle wobble: amplitude and rate, kept separate from every
  // other frequency in the file so the lamp never nods in time with the tail.
  let rodAmp = 0.14, rodFreq = 1.3;

  switch (ctx.action) {
    case 'idle': {
      // Hanging in the water almost motionless with the lamp swinging — the
      // entire hunting strategy of the animal, and the only idle in the roster
      // where the beast is doing something to you rather than pottering.
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
      // FLOPPING. A fish out of water, and like Finnick it is deliberately
      // graceless — but the failure mode is different and so is the animation:
      // Finnick throws its whole body forward, Lanternfin is too head-heavy for
      // that and simply thrashes on its side.
      const isRun = ctx.action === 'run';
      const f = (isRun ? 5.5 : 4.0) + 2.4 * ms;
      const ph = ctx.cycle(GAIT, f);
      const thrash = Math.sin(ph);
      brz = 0.42 * thrash;                               // lies over on a flank
      bry = 0.16 * Math.sin(ph * 0.5);
      bpy += 0.09 * Math.abs(thrash);
      bpx = 0.04 * Math.sin(ph * 0.5 - 0.6);
      bsy = 1 + 0.05 * Math.sin(ph * 2);
      hrz = -0.24 * thrash;
      hry = 0.14 * Math.sin(ph - 0.7);
      tby = 0.55 * Math.sin(ph - 0.6);
      tty = 0.70 * Math.sin(ph - 1.3);
      // The lamp swings wildly because nothing is holding it steady — this is
      // the one gait where the rod is passive.
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
      // Sculling. The tail sweeps side to side, the tip trailing it, and the
      // body yaws a little against the stroke — a fish, and the exact opposite
      // plane to Finnick's fluke.
      const f = 2.8 + 3.4 * ms;
      const ph = ctx.cycle(GAIT, f);
      tby = (0.34 + 0.24 * ms) * Math.sin(ph);
      tty = (0.48 + 0.32 * ms) * Math.sin(ph - 0.9);
      bry = 0.10 * Math.sin(ph + 0.4);
      brz = 0.09 * Math.sin(ph * 0.4);
      bpy += 0.035 * Math.sin(ph * 0.5);
      brx = -0.03;
      hry = -0.07 * Math.sin(ph + 0.4);
      // The rod stays STILL while the animal moves under it. That is the whole
      // trick of an angler: the lamp is bait, and bait that swings with the
      // swimmer is obviously attached to something.
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
      // The gulp. Head-first, jaw wide, and the rod snaps BACK out of the way —
      // the lure is bait, and an angler does not eat its own lamp.
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
      // The lamp is the spell. Everything else holds still and the rod comes
      // forward and DOWN to present it, pulsing on two mismatched sines so the
      // light reads as building rather than blinking.
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
      // A flat spin on the spot with the lamp trailing it — a ring of light,
      // which is the one thing a single emissive point can draw in the air.
      // About Y, so the lure stays in the horizontal plane where it is visible.
      const T = 0.85;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const settle = Math.sin(Math.PI * phase(at, T, T + 0.26))
        * (1 - smooth(phase(at, T + 0.26, T + 0.62)));
      bry = Math.PI * 4 * smooth(k2);
      bpy += 0.20 * spin;
      bsy = 1 - 0.12 * settle;
      brz = 0.30 * spin;                                 // banks into the turn
      rodX = 0.5 * spin;
      rodZ = 0.55 * spin;                                // the lamp flung wide
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
      // The lamp folds back over the skull, which is the one gesture that reads
      // as this animal flinching: the bright thing goes away.
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
      // Bobbing, with the lamp drawing figure-eights overhead. The rod does the
      // emoting because the face cannot — it is a mouth full of needles.
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

  // The rod, on its own integrated cycle so the lamp's wobble is never a
  // harmonic of the tail beat. `rodX`/`rodY`/`rodZ` are what the action asked
  // for; the wobble rides on top of all three.
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
  // The second pure swimmer, and it trades Finnick's speed for reach: 17.9 u/s
  // in water against 21.8, with four more attack and three more defense. On
  // land LAND_FLOP takes it to 5.7, under a walk — which is the joke.
  baseStats: { maxHp: 56, attack: 13, defense: 9, speed: 5.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
