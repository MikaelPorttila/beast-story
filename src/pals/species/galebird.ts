import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Galebird — a swift teal swallow, the fastest set of wings in the valley.
// Long forked tail streamers trail through its turns; wings tuck in dives.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette — teal-to-white gradient with a rust throat accent
const TEAL = 0x2fa9a4;      // main coat
const DEEP = 0x1c7480;      // back cap / leading wing edges
const DUSKTEAL = 0x145a66;  // wingtips
const UNDER = 0x0f4750;     // shaded wing underside (TEAL * 0.78)
const MIST = 0xcdeee8;      // gradient step toward the belly
const WHITE = 0xf6fdfb;     // belly
const RUST = 0xe8744f;      // throat patch accent
const BEAK = 0x2d2f3a;
const EYE_WHITE = 0xffffff;
const PUPIL = 0x1c1a24;
const STREAM_TIP = 0x0d3d47;

// Base pose constants (world/local units, must match buildRig)
const BODY_Y = 0.3;
const HEAD_Y = 0.1;
const HEAD_Z = 0.3;
const STREAM_X = -0.55;  // resting streamer droop
const STREAM_YAW = 0.14; // fork spread

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.8, -0.2, 2.2, 1.8, 3.8, TEAL);   // sleek fuselage
  m.ellipsoid(0, 2.7, -0.8, 1.8, 1.2, 3.0, DEEP);   // dark back cap
  m.ellipsoid(0, 0.9, 0.5, 1.9, 1.3, 3.2, MIST);    // gradient step
  m.ellipsoid(0, 0.4, 0.7, 1.6, 0.9, 2.7, WHITE);   // white belly
  m.ellipsoid(0, 1.9, -3.3, 1.2, 1.1, 1.4, DEEP);   // tapered rump
  // Two tucked legs with small feet. Without them the bird stood on a single
  // belly point — a T-on-a-stick silhouette whenever it perched.
  for (const sx of [1, -1]) {
    m.set(sx, -1, 0, BEAK);
    m.set(sx, -2, 0, BEAK);
    m.box(sx, -3, 0, sx, -3, 1, BEAK); // foot, toes forward
  }
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.3, 0.3, 2.0, 1.4, 1.7, TEAL);
  m.ellipsoid(0, 1.9, 0.0, 1.7, 0.9, 1.4, DEEP);    // dark cap down to the eye line
  m.ellipsoid(0, 0.5, 1.4, 1.2, 0.8, 0.9, RUST);    // rust throat patch
  // Eyes: 2x2 white blocks proud of the face, pupil on the inner-lower cell
  for (const sx of [1, -1]) {
    m.set(sx * 1, 2, 2, EYE_WHITE);
    m.set(sx * 2, 2, 2, EYE_WHITE);
    m.set(sx * 2, 1, 2, EYE_WHITE);
    m.set(sx * 1, 1, 2, PUPIL);
  }
  return m.build(S, true);
}

function makeBeak(): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, BEAK);
  m.set(0, 0, 1, BEAK); // tiny, sharp, two cells long
  return m.build(S, true);
}

/**
 * Inner wing section. dir=1 builds toward +x (left), dir=-1 mirrors.
 * The chord steps in toward the tip and the root carries a darker underside
 * row — a flat untapered rectangle reads as a plank, not a wing.
 */
function makeWingInner(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  // per-column trailing edge: chord narrows as it runs outboard
  const back = [-2, -2, -1];
  for (let x = 0; x <= 2; x++) {
    m.box(X(x), 0, back[x], X(x), 0, 2, TEAL);
    m.set(X(x), 0, 2, DEEP);          // leading edge
    m.set(X(x), 0, back[x], MIST);    // pale trailing edge
    // shaded underside gives the wing thickness from below
    if (x < 2) m.box(X(x), -1, back[x] + 1, X(x), -1, 1, UNDER);
  }
  return m.build(S, false);
}

/** Outer wing section, tapering to a single-voxel swept point. */
function makeWingOuter(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  // chord: 4 cells at the elbow down to 1 at the tip
  m.box(X(0), 0, -2, X(0), 0, 1, TEAL);
  m.box(X(1), 0, -2, X(1), 0, 0, TEAL);
  m.box(X(2), 0, -3, X(2), 0, -1, DUSKTEAL); // swept pointed tip
  m.set(X(0), 0, 1, DEEP);                   // leading edge
  m.set(X(1), 0, 0, DEEP);
  m.set(X(0), 0, -2, MIST);                  // trailing edge near body
  m.box(X(0), -1, -1, X(0), -1, 0, UNDER);   // underside at the root only
  return m.build(S, false);
}

function makeTailFan(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(-1, 0, -2, 1, 0, 0, TEAL);
  m.box(-1, 0, -2, 1, 0, -2, DEEP);
  return m.build(S, true);
}

function makeStreamer(): THREE.Mesh {
  const m = new VoxelModel();
  const colors = [DEEP, DEEP, DUSKTEAL, DUSKTEAL, STREAM_TIP, STREAM_TIP, STREAM_TIP];
  for (let i = 0; i < colors.length; i++) m.set(0, 0, -i, colors[i]);
  return m.build(S, false);
}

function buildRig(): PalRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.2, 0);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.14, 0.02);
  head.add(headMesh);

  const beak = makeBeak();
  beak.position.set(0, -0.03, 0.24);
  head.add(beak);

  // Wings: two hinged sections per side, pivots at the shoulder and elbow.
  const mkWing = (dir: 1 | -1): [THREE.Group, THREE.Group] => {
    const shoulder = new THREE.Group();
    shoulder.position.set(dir * 0.17, 0.06, 0.04);
    body.add(shoulder);
    const inner = makeWingInner(dir);
    inner.position.set(0, -0.05, 0);
    shoulder.add(inner);
    const elbow = new THREE.Group();
    elbow.position.set(dir * 0.28, 0, -0.02);
    shoulder.add(elbow);
    const outer = makeWingOuter(dir);
    outer.position.set(0, -0.05, 0);
    elbow.add(outer);
    return [shoulder, elbow];
  };
  const [wingL, wingLOut] = mkWing(1);
  const [wingR, wingROut] = mkWing(-1);

  const tail = new THREE.Group();
  tail.position.set(0, 0.02, -0.36);
  body.add(tail);
  const fan = makeTailFan();
  fan.position.set(0, -0.05, 0.02);
  tail.add(fan);

  // Forked tail streamers — long, thin, trailing.
  const mkStreamer = (dir: 1 | -1): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(dir * 0.06, 0, -0.14);
    g.rotation.set(STREAM_X, dir * STREAM_YAW, 0);
    tail.add(g);
    const mesh = makeStreamer();
    mesh.position.set(-0.05, -0.05, 0.06);
    g.add(mesh);
    return g;
  };
  const streamerL = mkStreamer(1);
  const streamerR = mkStreamer(-1);

  return {
    root,
    parts: { body, head, beak, wingL, wingLOut, wingR, wingROut, tail, streamerL, streamerR },
    height: 0.55,
    radius: 0.35,
  };
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.2);

  // Pose state — everything is written every frame.
  let bpx = 0, bpy = BODY_Y, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.01 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0;
  let beakX = 0;
  let flapL = 0.12, flapR = 0.12, outL = 0.1, outR = 0.1;
  let sweepL = 0.15, sweepR = 0.15;
  let tfx = 0.1, tfy = 0;
  let slx = STREAM_X, sly = 0, srx = STREAM_X, sry = 0;

  switch (ctx.action) {
    case 'idle': {
      // Hovering flutter: quick shallow beats, curious looks, streamers swaying.
      const ph = t * 4.4;
      flapL = flapR = 0.15 + 0.5 * Math.sin(ph);
      outL = outR = 0.45 * Math.sin(ph - 0.9);
      sweepL = sweepR = 0.12 + 0.05 * Math.sin(ph - 0.4);
      bpy += 0.035 * Math.sin(ph - 1.3) + 0.02 * Math.sin(t * 1.3);
      bsy = 1 + 0.02 * br;
      bsx = bsz = 1 - 0.008 * br;
      brx = 0.1 + 0.02 * Math.sin(t * 1.1); // slightly nose-up hover
      hrx = -0.08 + 0.05 * Math.sin(t * 1.2 + 0.5);
      hry = 0.3 * Math.sin(t * 0.33);
      hrz = 0.04 * Math.sin(t * 0.5) + 0.28 * Math.max(0, Math.sin(t * 0.41 + 1.7)) ** 12; // curious tilt
      beakX = 0.3 * Math.max(0, Math.sin(t * 0.27 + 3)) ** 24; // occasional chirp
      tfx = 0.15 + 0.06 * Math.sin(t * 1.7);
      tfy = 0.08 * Math.sin(t * 0.9);
      const sw = t * 1.5;
      slx = STREAM_X + 0.08 * Math.sin(sw);
      srx = STREAM_X + 0.08 * Math.sin(sw + 0.7);
      sly = 0.16 * Math.sin(sw - 0.9);
      sry = 0.16 * Math.sin(sw - 1.6);
      break;
    }
    case 'walk':
    case 'run':
    case 'swim':
    case 'fly': {
      // Darting flight: flap bursts, brief glides, hard banks; wings tuck in dives.
      const f = 7.5 + 5 * ms;
      const ph = t * f;
      const glide = Math.max(0, Math.sin(t * 0.47 + 2.0)) ** 6;
      const dive = smooth(clamp01((ms - 0.65) / 0.35)) * Math.max(0, Math.sin(t * 0.31 + 0.8)) ** 4;
      const g = glide * (1 - dive);
      const amp = (0.55 + 0.45 * ms) * (1 - 0.85 * g) * (1 - 0.9 * dive);
      const bank = 0.42 * Math.sin(t * 0.77) * ms * (1 - dive);
      flapL = amp * Math.sin(ph) + 0.1 + 0.15 * g - 0.55 * dive + 0.1 * bank;
      flapR = amp * Math.sin(ph + 0.07) + 0.1 + 0.15 * g - 0.55 * dive - 0.1 * bank;
      outL = amp * 1.3 * Math.sin(ph - 0.75) + 0.05 - 0.35 * dive;
      outR = amp * 1.3 * Math.sin(ph - 0.68) + 0.05 - 0.35 * dive;
      sweepL = sweepR = 0.18 + 0.25 * ms + 0.85 * dive - 0.12 * g; // tuck hard in dives
      brz = bank;
      bry = 0.16 * Math.sin(t * 0.77 - 0.5) * ms;
      brx = -0.04 + 0.16 * ms + 0.35 * dive - 0.08 * g;
      bpy += 0.035 * Math.sin(ph - 1.1) * (1 - g) * (1 - dive) + 0.025 * Math.sin(t * 1.9) - 0.06 * dive;
      bpz = 0.05 * dive;
      bsz = 1 + 0.05 * dive;
      bsx = 1 - 0.03 * dive;
      hrx = -brx * 0.75; // gaze stabilization against pitch
      hry = -bry * 0.6;
      hrz = -bank * 0.55;
      tfx = 0.08 + 0.1 * ms - 0.15 * dive;
      tfy = -0.3 * bank; // fan steers into the turn
      slx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1);
      srx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1 + 0.6);
      sly = -1.1 * bank + 0.18 * Math.sin(t * 2.7); // streamers trail wide in turns
      sry = -1.1 * bank + 0.18 * Math.sin(t * 2.7 + 0.8);
      break;
    }
    case 'attack': {
      // Slashing dive-strike: rear up wings-high, then shear forward, tucked.
      const wind = smooth(phase(at, 0, 0.14));
      const lunge = ezOut(phase(at, 0.14, 0.3));
      const rec = smooth(phase(at, 0.5, 0.85));
      const k = -wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      brx = -0.45 * wind * (1 - lunge) + 0.5 * kp;
      bpz = 0.28 * k;
      bpy += 0.1 * wind * (1 - lunge) - 0.05 * kp;
      bsz = 1 + 0.12 * kp;
      bsx = 1 - 0.05 * kp;
      flapL = flapR = 1.1 * wind * (1 - lunge) - 0.5 * kp + 0.15 * Math.sin(t * 30) * kp;
      outL = outR = 0.5 * wind * (1 - lunge) - 0.35 * kp;
      sweepL = sweepR = 0.15 + 0.9 * kp;
      hrx = -brx * 0.6; // beak stays locked on the target
      beakX = 0.5 * kp;
      tfx = 0.3 * wind * (1 - lunge) - 0.2 * kp;
      slx = srx = STREAM_X + 0.2 * wind + 0.75 * kp;
      sly = 0.3 * Math.sin(at * 28) * kp;
      sry = -sly;
      break;
    }
    case 'cast': {
      // Rear-up flourish: wings fanned wide, tips trembling with gathered wind.
      const rise = ezOut(clamp01(at / 0.4));
      const trem = 0.5 * Math.sin(t * 14) + 0.5 * Math.sin(t * 21);
      brx = -0.55 * rise + 0.02 * trem * rise;
      bpy += 0.12 * rise;
      flapL = flapR = 0.95 * rise + 0.1 * Math.sin(t * 23) * rise;
      outL = outR = 0.35 * rise + 0.18 * Math.sin(t * 23 + 1.2) * rise;
      sweepL = sweepR = 0.15 - 0.25 * rise;
      hrx = 0.35 * rise; // gaze stays down-range
      beakX = 0.35 * rise;
      tfx = 0.3 * rise;
      slx = srx = STREAM_X - 0.3 * rise;
      sly = 0.35 * rise + 0.05 * Math.sin(t * 9);
      sry = -0.35 * rise - 0.05 * Math.sin(t * 9 + 1);
      break;
    }
    case 'special': {
      // Barrel-roll gale: full roll, then a huge braking wing-flare.
      const T = 0.85;
      const k = clamp01(at / T);
      const arc = Math.sin(Math.PI * k);
      const flare = Math.sin(Math.PI * phase(at, T, T + 0.3)) * (1 - smooth(phase(at, T + 0.3, T + 0.7)));
      brz = Math.PI * 2 * smooth(k);
      brx = -0.2 * arc - 0.3 * flare;
      bpy += 0.3 * arc + 0.08 * flare;
      flapL = flapR = 0.35 - 0.2 * arc + 1.0 * flare;
      outL = outR = 0.2 + 0.5 * flare;
      sweepL = sweepR = 0.15 + 0.6 * arc * (1 - flare);
      hrz = -0.2 * flare;
      hrx = -0.15 * flare;
      beakX = 0.4 * flare;
      tfy = 0.3 * Math.sin(at * 16 + 1);
      slx = srx = STREAM_X + 0.5 * arc;
      sly = 0.9 * Math.sin(at * 16); // streamers corkscrew through the roll
      sry = 0.9 * Math.sin(at * 16 + 2.1);
      break;
    }
    case 'hurt': {
      // Feathers-everywhere flinch: knocked back, wings flailing out of sync.
      const d = Math.exp(-3.5 * at);
      bpx = 0.05 * Math.sin(at * 40) * d;
      bpy += -0.07 * d + 0.02 * Math.sin(at * 35) * d;
      bpz = -0.12 * d;
      brz = 0.25 * Math.sin(at * 26) * d;
      brx = -0.2 * d;
      flapL = (0.3 + 0.8 * Math.sin(at * 34)) * d + 0.12 * (1 - d);
      flapR = (0.3 + 0.8 * Math.sin(at * 34 + Math.PI)) * d + 0.12 * (1 - d);
      outL = 0.5 * Math.sin(at * 34 + 1) * d;
      outR = 0.5 * Math.sin(at * 34 + Math.PI + 1) * d;
      hrx = -0.3 * d;
      hrz = 0.15 * Math.sin(at * 30) * d;
      beakX = 0.6 * d;
      slx = srx = STREAM_X - 0.3 * d;
      sly = 0.2 * Math.sin(at * 30) * d;
      sry = -sly;
      break;
    }
    case 'happy': {
      // Giddy bounce-hover with chirps and streamer swishes.
      const hf = 5.4;
      const hop = Math.abs(Math.sin(at * hf));
      const ph = t * 13;
      bpy += 0.15 * hop;
      bry = 0.3 * Math.sin(at * 2.4);
      brz = 0.08 * Math.sin(at * hf * 2);
      flapL = 0.3 + 0.55 * Math.sin(ph);
      flapR = 0.3 + 0.55 * Math.sin(ph + 0.3);
      outL = 0.5 * Math.sin(ph - 0.7);
      outR = 0.5 * Math.sin(ph - 0.4);
      sweepL = sweepR = 0.1;
      hrx = -0.12;
      hrz = 0.25 * Math.sin(at * 2.4 + 1);
      beakX = 0.4 * Math.max(0, Math.sin(at * hf)) ** 2; // chirping with each hop
      tfx = 0.25;
      tfy = 0.25 * Math.sin(at * 6);
      const wag = at * 12;
      slx = srx = STREAM_X + 0.2;
      sly = 0.5 * Math.sin(wag);
      sry = 0.5 * Math.sin(wag - 0.7);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, HEAD_Y, HEAD_Z);
  p.head.rotation.set(hrx, hry, hrz);
  p.beak.rotation.set(beakX, 0, 0);
  p.wingL.rotation.set(0, sweepL, flapL);
  p.wingR.rotation.set(0, -sweepR, -flapR);
  p.wingLOut.rotation.set(0, 0.25 * sweepL, outL);
  p.wingROut.rotation.set(0, -0.25 * sweepR, -outR);
  p.tail.rotation.set(tfx, tfy, 0);
  p.streamerL.rotation.set(slx, STREAM_YAW + sly, 0.02 * Math.sin(t * 8.3));
  p.streamerR.rotation.set(srx, -STREAM_YAW + sry, 0.02 * Math.sin(t * 8.3 + 1.4));
}

export const skills: SkillDef[] = [
  {
    id: 'galebird.gust-dart',
    name: 'Gust Dart',
    description: 'Snaps its wings shut and flings a whistling blade of compressed air.',
    element: 'wind',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.6,
    power: 10,
    range: 16,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'galebird.skyshear-dive',
    name: 'Skyshear Dive',
    description: 'Folds into a teardrop and shears past the target, wingtips slicing like scissors.',
    element: 'wind',
    targeting: 'melee',
    cost: 11,
    cooldown: 3.6,
    power: 20,
    range: 3,
    learnAtLevel: 5,
    castAnim: 'attack',
  },
  {
    id: 'galebird.tailwind',
    name: 'Tailwind',
    description: 'Carves a lazy circle overhead, kicking up a tailwind that hurries the whole team along.',
    element: 'wind',
    targeting: 'support',
    cost: 12,
    cooldown: 9,
    power: 10,
    range: 7,
    storePrice: 150,
    castAnim: 'cast',
  },
  {
    id: 'galebird.cyclone-waltz',
    name: 'Cyclone Waltz',
    description: 'Spins a pirouette so fast the sky joins in, wrapping everything nearby in a shrieking tornado.',
    element: 'wind',
    targeting: 'aoe',
    cost: 23,
    cooldown: 11,
    power: 42,
    range: 5,
    storePrice: 380,
    castAnim: 'special',
  },
];

export const species: PalSpecies = {
  id: 'galebird',
  name: 'Galebird',
  element: 'wind',
  locomotion: 'flying',
  description:
    'A wind-stitched swallow that treats gravity as a polite suggestion — the fastest wings in the valley.',
  baseStats: { maxHp: 36, attack: 12, defense: 4, speed: 8.0 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
