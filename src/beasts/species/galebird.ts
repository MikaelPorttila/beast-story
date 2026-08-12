import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// Galebird — teal swallow, the fastest wings in the valley; forked streamers trail its
// turns. Voxel scale 0.1 (1 cell = 10 cm), faces +Z, root at ground level.

const S = 0.1;

// Every teal sits a step above where it started: against dark canopy with its shaded side
// to camera, a ~40% mid-tone was one black smudge (fill 0.52 against a 2.55 sun).
const TEAL = 0x54dbcd;
const RIM = 0xb2f6e9;
const DEEP = 0x2f9cae;
const DUSKTEAL = 0x27889a;
const UNDER = 0x5b93a4;
const MIST = 0xcdeee8;
const WHITE = 0xf6fdfb;
const RUST = 0xf2814f;
const BEAK = 0xffc24d;
const BEAK_DK = 0xc07f21;
const FOOT = 0x4d5361;
const TOE = 0x8f96a3;
// Dark iris, light face, as everywhere in the roster.
const IRIS = 0x0f2b33;
const SHINE = 0xf2ffff;
const COLLAR = 0xd9f4ee;
const STREAM_TIP = 0xd8ecf2;

const BODY_Y = 0.3;
// Must match buildRig. The skull steps UP and FORWARD out of the shoulder line: flush,
// there was no head/body break and the bird read as one teal lozenge with a bill.
const HEAD_Y = 0.07;
const HEAD_Z = 0.30;
const STREAM_X = -0.55;
const STREAM_YAW = 0.14;
const HOVER = 1.55;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// One integrated wingbeat phase (BeastAnimCtx.cycle) for every branch that beats: hover,
// paddle, cruise and bounce are one pair of wings changing PACE, so the pose cannot jump.
const BEAT = 0;
/** The forked streamers, which sway at their own leisurely rate. */
const SWAY = 1;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  // Fuselage must out-measure the skull: a 7-cell head on a 5-cell body hid the body.
  m.ellipsoid(0, 1.8, -0.2, 2.6, 1.9, 3.8, TEAL);
  m.ellipsoid(0, 2.7, -0.8, 1.8, 1.2, 3.0, DEEP);
  m.ellipsoid(0, 0.9, 0.5, 1.9, 1.3, 3.2, MIST);
  m.ellipsoid(0, 0.4, 0.7, 1.6, 0.9, 2.7, WHITE);
  m.ellipsoid(0, 1.9, -3.3, 1.2, 1.1, 1.4, DEEP);
  rimTop(m, RIM, -2, 2, 0, 5, -5, 4);
  shadeUnder(m, UNDER, -2, 2, 0, 4, -5, 4);
  // TWO legs, not one block — the third mass makes the silhouette read. Each leg's top cell
  // sits inside the belly, so no pose opens a gap at the hip.
  for (const sx of [1, -1]) {
    m.box(sx, -2, -1, sx, 0, 1, FOOT);
    m.set(sx, -2, 2, TOE);
    m.set(sx * 2, -2, 1, TOE);
    m.set(sx, -2, -2, FOOT);
  }
  // Nape band on the THROAT only: run across the shoulders it appeared above the skull
  // head-on as a pale plate floating on the bird.
  for (let x = -1; x <= 1; x++) m.set(x, 2, 3, COLLAR);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.9, 0.1, 2.3, 1.8, 1.7, TEAL);
  m.ellipsoid(0, 3.0, -0.3, 2.0, 0.9, 1.4, DEEP);
  m.ellipsoid(0, 0.9, 1.2, 1.3, 0.8, 1.0, RUST);
  m.box(-2, 1, 2, 2, 4, 2, TEAL);   // face plate; on the bare ellipsoid the outer eye
                                    // column floated free of the skull
  rimTop(m, RIM, -2, 2, 0, 5, -2, 2);
  shadeUnder(m, DUSKTEAL, -2, 2, 0, 1, -2, 0);
  // Pale mask before the eyes go in: on a teal plate in shade a dark teal iris has no
  // boundary. It doubles as the swallow's pale cheek.
  for (let x = -2; x <= 2; x++) { m.set(x, 2, 2, MIST); m.set(x, 3, 2, MIST); }
  eyes2x2(m, {
    inner: 1, width: 1, y: 2, faceZ: 2, iris: IRIS, shine: SHINE,
    lid: DUSKTEAL, browProud: true, bridge: RIM,
  });
  return m.build(S, true);
}

function makeBeak(): THREE.Mesh {
  const m = new VoxelModel();
  // ONE cell wide: on a five-cell skull a 3-wide bill covered half the face and read as a
  // gold ingot with a bird behind it.
  m.set(0, 1, 0, BEAK);
  m.set(0, 0, 0, BEAK_DK);
  m.set(0, 1, 1, BEAK);
  m.set(0, 1, 2, BEAK);
  return m.build(S, true);
}

/**
 * Inner wing. dir=1 builds toward +x. Two voxel layers over the full chord: a one-cell
 * plank is invisible edge-on. The taper lives in the outer section.
 */
function makeWingInner(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  for (let x = 0; x <= 2; x++) {
    m.box(X(x), 0, -3, X(x), 0, 2, TEAL);
    m.set(X(x), 0, 2, RIM);
    m.set(X(x), 0, -3, DUSKTEAL);
    m.box(X(x), -1, -3, X(x), -1, 1, UNDER);
  }
  return m.build(S, false);
}

function makeWingOuter(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  // Six columns put the tip at 1.05 — the longest wing in the roster relative to its owner,
  // which is a swallow's defining shape. Both edges rake aft for the scimitar plan form.
  const front = [1, 0, -1, -2, -3, -4];
  const back = [-3, -3, -4, -4, -5, -5];
  for (let x = 0; x < 6; x++) {
    const tip = x >= 4;   // dark primaries, or the taper fades into the sky
    m.box(X(x), 0, back[x], X(x), 0, front[x], tip ? DUSKTEAL : TEAL);
    m.set(X(x), 0, front[x], tip ? DUSKTEAL : RIM);
    m.set(X(x), 0, back[x], DUSKTEAL);
    if (x < 4) m.box(X(x), -1, back[x], X(x), -1, front[x] - 1, UNDER);
  }
  return m.build(S, false);
}

function makeTailFan(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(-2, 0, -3, 2, 0, 0, TEAL);
  m.box(-2, 0, -3, 2, 0, -3, DEEP);
  m.box(-1, -1, -2, 1, -1, 0, UNDER);
  m.set(-2, 0, 0, MIST);
  m.set(2, 0, 0, MIST);
  return m.build(S, true);
}

function makeStreamer(): THREE.Mesh {
  const m = new VoxelModel();
  const colors = [DEEP, DEEP, TEAL, TEAL, STREAM_TIP, STREAM_TIP, STREAM_TIP];
  for (let i = 0; i < colors.length; i++) {
    m.set(0, 0, -i, colors[i]);
    if (i < 4) m.set(1, 0, -i, colors[i]); // 1x1 was a hairline and the fork vanished
  }
  return m.build(S, false);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  // build() anchors y=0 at the lowest voxel, so this holds the fuselage altitude.
  torso.position.set(0, -0.1, 0);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  // -0.22: the skull's extra bottom row has to drop the pivot with it.
  headMesh.position.set(0, -0.22, 0.02);
  head.add(headMesh);

  const beak = makeBeak();
  // Level with the bottom eye row: across the middle, beak and irises merged into one bar.
  beak.position.set(0, -0.16, 0.25);
  head.add(beak);

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

  // Ground contact blob — see contactshadow.ts.
  const blob = makeContactBlob(0.5, HOVER);
  root.add(blob);

  return {
    root,
    parts: {
      body, head, beak, wingL, wingLOut, wingR, wingROut, tail, streamerL, streamerR, blob,
    },
    height: 0.55,
    radius: 0.35,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.2);

  updateContactBlob(p.blob, rig.root, 1 + 0.3 * clamp01(p.wingL.rotation.z), ctx.altitude);

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
      const ph = ctx.cycle(BEAT, 4.4);
      // Shallow beat centred just above level: swinging past vertical caught both wings
      // edge-on behind the skull in a head-on hover. Wrist rule as in flight below.
      flapL = flapR = 0.09 + 0.3 * Math.sin(ph);
      outL = outR = 0.18 * Math.sin(ph - 0.45);
      sweepL = sweepR = 0.12 + 0.05 * Math.sin(ph - 0.4);
      bpy += 0.035 * Math.sin(ph - 1.3) + 0.02 * Math.sin(t * 1.3);
      bsy = 1 + 0.02 * br;
      bsx = bsz = 1 - 0.008 * br;
      brx = 0.03 + 0.02 * Math.sin(t * 1.1);
      hrx = -0.08 + 0.05 * Math.sin(t * 1.2 + 0.5);
      hry = 0.3 * Math.sin(t * 0.33);
      hrz = 0.04 * Math.sin(t * 0.5) + 0.28 * Math.max(0, Math.sin(t * 0.41 + 1.7)) ** 12;
      beakX = 0.3 * Math.max(0, Math.sin(t * 0.27 + 3)) ** 24;
      tfx = 0.15 + 0.06 * Math.sin(t * 1.7);
      tfy = 0.08 * Math.sin(t * 0.9);
      const sw = ctx.cycle(SWAY, 1.5);
      slx = STREAM_X + 0.08 * Math.sin(sw);
      srx = STREAM_X + 0.08 * Math.sin(sw + 0.7);
      sly = 0.16 * Math.sin(sw - 0.9);
      sry = 0.16 * Math.sin(sw - 1.6);
      break;
    }
    case 'swim': {
      const ph = ctx.cycle(BEAT, 3.4);
      flapL = 0.1 + 0.34 * Math.sin(ph);
      flapR = 0.1 + 0.34 * Math.sin(ph + Math.PI);
      outL = 0.5 + 0.22 * Math.sin(ph - 0.7);
      outR = 0.5 + 0.22 * Math.sin(ph + Math.PI - 0.7);
      sweepL = sweepR = 0.85;
      bpy += 0.02 * Math.sin(t * 2.1) - 0.03;
      brx = -0.12;
      brz = 0.06 * Math.sin(ph);
      hrx = 0.1 + 0.05 * Math.sin(t * 1.4);
      hry = 0.22 * Math.sin(t * 0.5);
      beakX = 0.25 * Math.max(0, Math.sin(t * 0.9)) ** 12;
      tfx = -0.15;
      tfy = 0.1 * Math.sin(ph - 0.9);
      slx = srx = STREAM_X - 0.55;
      sly = 0.3 * Math.sin(t * 1.6);
      sry = 0.3 * Math.sin(t * 1.6 + 1.1);
      break;
    }
    case 'walk':
    case 'run':
    case 'fly': {
      // Integrated, not `t * f`: at a 35 s clock a moveSpeed catch-up moved the wing 1.86 rad
      // in ONE frame (test-beastanim); integrated, the same run steps 0.28.
      const f = 7.5 + 5 * ms;
      const ph = ctx.cycle(BEAT, f);
      const glide = Math.max(0, Math.sin(t * 0.47 + 2.0)) ** 6;
      const dive = smooth(clamp01((ms - 0.65) / 0.35)) * Math.max(0, Math.sin(t * 0.31 + 0.8)) ** 4;
      const g = glide * (1 - dive);
      const amp = (0.55 + 0.45 * ms) * (1 - 0.85 * g) * (1 - 0.9 * dive);
      const bank = 0.42 * Math.sin(t * 0.77) * ms * (1 - dive);
      // Wrist FOLLOWS the shoulder (0.62x, 0.42 rad lag): matched a half-cycle behind, both
      // joints peaked together and creased the wing into fins. Centre 0.17 = dihedral V.
      flapL = amp * Math.sin(ph) + 0.17 + 0.15 * g - 0.55 * dive + 0.1 * bank;
      flapR = amp * Math.sin(ph + 0.07) + 0.17 + 0.15 * g - 0.55 * dive - 0.1 * bank;
      outL = amp * 0.62 * Math.sin(ph - 0.42) + 0.05 - 0.35 * dive;
      outR = amp * 0.62 * Math.sin(ph - 0.35) + 0.05 - 0.35 * dive;
      sweepL = sweepR = 0.18 + 0.25 * ms + 0.85 * dive - 0.12 * g;
      brz = bank;
      bry = 0.16 * Math.sin(t * 0.77 - 0.5) * ms;
      brx = -0.04 + 0.16 * ms + 0.35 * dive - 0.08 * g;
      bpy += 0.035 * Math.sin(ph - 1.1) * (1 - g) * (1 - dive) + 0.025 * Math.sin(t * 1.9) - 0.06 * dive;
      bpz = 0.05 * dive;
      bsz = 1 + 0.05 * dive;
      bsx = 1 - 0.03 * dive;
      hrx = -brx * 0.75;
      hry = -bry * 0.6;
      hrz = -bank * 0.55;
      tfx = 0.08 + 0.1 * ms - 0.15 * dive;
      tfy = -0.3 * bank;
      slx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1);
      srx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1 + 0.6);
      sly = -1.1 * bank + 0.18 * Math.sin(t * 2.7);
      sry = -1.1 * bank + 0.18 * Math.sin(t * 2.7 + 0.8);
      break;
    }
    case 'attack': {
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
      hrx = -brx * 0.6;
      beakX = 0.5 * kp;
      tfx = 0.3 * wind * (1 - lunge) - 0.2 * kp;
      slx = srx = STREAM_X + 0.2 * wind + 0.75 * kp;
      sly = 0.3 * Math.sin(at * 28) * kp;
      sry = -sly;
      break;
    }
    case 'cast': {
      const rise = ezOut(clamp01(at / 0.4));
      const trem = 0.5 * Math.sin(t * 14) + 0.5 * Math.sin(t * 21);
      brx = -0.55 * rise + 0.02 * trem * rise;
      bpy += 0.12 * rise;
      flapL = flapR = 0.95 * rise + 0.1 * Math.sin(t * 23) * rise;
      outL = outR = 0.35 * rise + 0.18 * Math.sin(t * 23 + 1.2) * rise;
      sweepL = sweepR = 0.15 - 0.25 * rise;
      hrx = 0.35 * rise;
      beakX = 0.35 * rise;
      tfx = 0.3 * rise;
      slx = srx = STREAM_X - 0.3 * rise;
      sly = 0.35 * rise + 0.05 * Math.sin(t * 9);
      sry = -0.35 * rise - 0.05 * Math.sin(t * 9 + 1);
      break;
    }
    case 'special': {
      const T = 0.85;
      const k = clamp01(at / T);
      const arc = Math.sin(Math.PI * k);
      const flare = Math.sin(Math.PI * phase(at, T, T + 0.3)) * (1 - smooth(phase(at, T + 0.3, T + 0.7)));
      // Damped sink with the wings drooping half a beat behind, so the roll ends on a breath
      // rather than snapping back to the hover pose.
      const settle = Math.exp(-4.5 * Math.max(0, at - (T + 0.3))) * smooth(phase(at, T + 0.25, T + 0.45));
      brz = Math.PI * 2 * smooth(k);
      brx = -0.2 * arc - 0.3 * flare + 0.14 * settle;
      bpy += 0.3 * arc + 0.08 * flare - 0.07 * settle;
      bsy = 1 - 0.09 * settle;
      bsx = bsz = 1 + 0.05 * settle;
      flapL = flapR = 0.35 - 0.2 * arc + 1.0 * flare - 0.4 * settle;
      outL = outR = 0.2 + 0.5 * flare - 0.5 * settle;
      sweepL = sweepR = 0.15 + 0.6 * arc * (1 - flare) + 0.3 * settle;
      hrz = -0.2 * flare;
      hrx = -0.15 * flare + 0.2 * settle;
      beakX = 0.4 * flare;
      tfy = 0.3 * Math.sin(at * 16 + 1);
      slx = srx = STREAM_X + 0.5 * arc;
      sly = 0.9 * Math.sin(at * 16);
      sry = 0.9 * Math.sin(at * 16 + 2.1);
      break;
    }
    case 'hurt': {
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
      const hf = 5.4;
      const hop = Math.abs(Math.sin(at * hf));
      const ph = ctx.cycle(BEAT, 13);
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
      beakX = 0.4 * Math.max(0, Math.sin(at * hf)) ** 2;
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
    nameKey: 'skill.galebird.gust-dart.name',
    descriptionKey: 'skill.galebird.gust-dart.desc',
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
    nameKey: 'skill.galebird.skyshear-dive.name',
    descriptionKey: 'skill.galebird.skyshear-dive.desc',
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
    nameKey: 'skill.galebird.tailwind.name',
    descriptionKey: 'skill.galebird.tailwind.desc',
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
    nameKey: 'skill.galebird.cyclone-waltz.name',
    descriptionKey: 'skill.galebird.cyclone-waltz.desc',
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

export const species: BeastSpecies = {
  id: 'galebird',
  nameKey: 'beast.galebird.name',
  element: 'wind',
  locomotion: 'flying',
  descriptionKey: 'beast.galebird.desc',
  baseStats: { maxHp: 36, attack: 12, defense: 4, speed: 8.0 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
