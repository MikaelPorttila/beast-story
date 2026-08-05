import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Snapclaw — a hermit crab that has moved into a spiral shell two sizes too
// grand for it. The ROCK-typed amphibian: the only beast in the roster whose
// element and medium disagree, which is exactly the "combo of types" the HUD's
// two-glyph badge exists to show.
//
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground /
// water level. Walks SIDEWAYS-ish with a scuttle — the legs run a travelling
// wave down each side rather than the diagonal pairs every other quadruped here
// uses, and that wave is the whole read.
//
// NO eyes2x2. This is the one face in the roster that is not a face: the eyes
// are on STALKS, they are two spheres on two sticks, and the house eye macro
// paints a flat plate. See makeEyestalk.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette. Two materials that must never be confused: the crab is warm
// orange-red chitin, the shell is cold banded stone. Every capture of an early
// pass where they shared a hue read as one lumpy object.
const CHITIN = 0xd4653c;      // carapace and legs
const CHITIN_LIT = 0xf1976a;
const CHITIN_DARK = 0x8f3d22;
const CLAW = 0xe0764a;        // the pincers, a shade brighter than the body
const CLAW_TIP = 0xfbd9b0;    // pale cutting edges — the only near-white on it
const SHELL = 0xa8a294;       // the borrowed house: cold grey stone
const SHELL_LIT = 0xd0cabb;
const SHELL_DARK = 0x6f6a5f;
const SHELL_BAND = 0x7f8f96;  // the spiral banding
const EYE = 0x1b1410;
const EYE_SHINE = 0xfff4e2;
const STALK = 0xc4562f;

// Base pose constants (must match buildRig)
const BODY_Y = 0.26;
/** Rest crouch of the six legs, front to back along each side. */
const LEG_REST: readonly number[] = [-0.34, 0, 0.34];
/** How far each side's legs splay outward at rest. */
const LEG_SPLAY = 0.62;
/** Rest pose of the big claw and the small one. */
const BIG_REST = -0.30;
const SMALL_REST = -0.16;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/** Integrated cycle slots — see BeastAnimCtx.cycle(). */
const GAIT = 0;    // the scuttle wave down the legs
const STALKW = 1;  // the eyestalks, which never stop swivelling

const LEG_R = ['legR1', 'legR2', 'legR3'] as const;
const LEG_L = ['legL1', 'legL2', 'legL3'] as const;

function makeCarapace(): THREE.Mesh {
  const m = new VoxelModel();
  // WIDER THAN LONG, which is the one proportion that says crab before any
  // detail does. 5.6 across against 3.6 deep.
  m.ellipsoid(0, 1.6, 0, 5.6, 1.8, 3.6, CHITIN);
  m.ellipsoid(0, 0.6, 0.4, 4.6, 0.9, 2.8, CHITIN_DARK);   // underside
  // A brow ridge over the eyestalk sockets: two cells proud at the front, which
  // is what stops the stalks reading as antennae stuck into a pebble.
  m.box(-2, 3, 3, -1, 3, 3, CHITIN_LIT);
  m.box(1, 3, 3, 2, 3, 3, CHITIN_LIT);
  // Mouthparts: a dark notch between the brows. One cell, and it is the only
  // thing on the front of this animal that is not orange.
  m.box(-1, 1, 4, 1, 1, 4, CHITIN_DARK);
  shadeUnder(m, CHITIN_DARK, -6, 6, 0, 2, -4, 4);
  rimTop(m, CHITIN_LIT, -6, 6, 1, 4, -4, 4);
  return m.build(S, true);
}

/**
 * The borrowed shell — a fat spiral cone riding on the crab's back.
 *
 * Painted as four stacked rings of falling radius with a band recoloured on
 * each, and rotated a sixth of a turn per ring, which is as much of a spiral as
 * a voxel grid will carry legibly at this size. A real helix at 1-cell
 * resolution comes out as a lumpy sausage.
 */
function makeShell(): THREE.Mesh {
  const m = new VoxelModel();
  const rings: Array<[number, number, number]> = [
    [0.0, 4.2, 0], [2.2, 3.4, 1], [4.0, 2.4, 2], [5.4, 1.4, 3],
  ];
  for (const [y, r, i] of rings) {
    m.ellipsoid(0, y, -i * 0.5, r, 1.5, r, SHELL);
    // One banded stripe per ring, walked round by the ring index so the bands
    // step and the eye reads a twist.
    const a = i * 1.05;
    const bx = Math.round(Math.cos(a) * (r - 0.6));
    const bz = Math.round(Math.sin(a) * (r - 0.6));
    for (let dy = 0; dy <= 1; dy++) {
      if (m.has(bx, Math.round(y) + dy, bz)) m.set(bx, Math.round(y) + dy, bz, SHELL_BAND);
      if (m.has(-bx, Math.round(y) + dy, -bz)) m.set(-bx, Math.round(y) + dy, -bz, SHELL_BAND);
    }
  }
  m.set(0, 7, -2, SHELL_LIT);                              // the apex
  shadeUnder(m, SHELL_DARK, -5, 5, 0, 2, -5, 5);
  rimTop(m, SHELL_LIT, -5, 5, 2, 8, -5, 5);
  return m.build(S, true);
}

/**
 * One eyestalk: a two-cell stick with a bead on top. Built with the pivot at
 * the base (center=false), so the whole thing swivels from the socket.
 */
function makeEyestalk(): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, STALK);
  m.set(0, 1, 0, STALK);
  m.set(0, 2, 0, EYE);
  // The catchlight, one cell, on the FRONT of the bead rather than the top:
  // these two beads are the entire face and a glint on the crown is invisible
  // from the follow camera, which looks slightly down.
  m.set(0, 2, 1, EYE_SHINE);
  return m.build(S, false);
}

/**
 * One pincer. `big` grows the whole thing by a cell in every direction — a
 * hermit crab's claws are famously mismatched, and giving both arms the same
 * mesh is the first thing that makes one read as a toy.
 */
function makeClaw(big: boolean): THREE.Mesh {
  const m = new VoxelModel();
  const w = big ? 2 : 1;
  const l = big ? 4 : 3;
  m.box(0, 0, 0, 1, 1, 1, CHITIN);                          // the arm
  m.ellipsoid(0, 1, -(l - 1), w, 1.4, l * 0.6, CLAW);       // the hand
  // The jaws: an upper and a lower blade with a gap between them, and the gap
  // is what says "this opens". A solid block would be a mitten.
  m.box(-w, 3, -l - 1, w, 3, -l + 1, CLAW);
  m.box(-w, 0, -l - 1, w, 0, -l + 1, CLAW);
  for (let x = -w; x <= w; x++) {
    m.set(x, 3, -l - 1, CLAW_TIP);
    m.set(x, 0, -l - 1, CLAW_TIP);
  }
  shadeUnder(m, CHITIN_DARK, -3, 3, 0, 2, -7, 2);
  rimTop(m, CHITIN_LIT, -3, 3, 1, 4, -7, 2);
  return m.build(S, false);
}

/**
 * One walking leg — a thin two-segment stick ending in a point. `dir` is +1 for
 * a leg growing toward +X.
 *
 * MIRRORED BY PAINTING IT THE OTHER WAY, never by `scale.x = -1` on the mesh:
 * a negative scale flips the winding order, so every face on that side lights
 * from the wrong hemisphere and the left legs come out shaded as if the sun had
 * moved. Same rule Aquaxol's gill fronds follow.
 */
function makeLeg(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, dir * 2, 0, 0, CHITIN);
  m.box(dir * 3, -1, 0, dir * 3, 0, 0, CHITIN_DARK);
  m.set(dir * 4, -2, 0, CHITIN_DARK);
  return m.build(S, false);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const carapace = makeCarapace();
  carapace.position.set(0, -0.10, 0);
  body.add(carapace);

  // The shell is its own group and it LAGS the body in every gait below. It is
  // a borrowed house, not part of the animal, and the half-beat of lag is the
  // one detail that says so without a word of explanation.
  const shell = new THREE.Group();
  shell.position.set(0, 0.10, -0.24);
  shell.rotation.set(-0.34, 0.4, 0);
  body.add(shell);
  const shellMesh = makeShell();
  shellMesh.position.set(0, 0.06, -0.10);
  shell.add(shellMesh);

  const mkStalk = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.22, 0.30);
    body.add(g);
    const mesh = makeEyestalk();
    mesh.position.set(-0.05, 0, -0.05);
    g.add(mesh);
    return g;
  };
  const stalkR = mkStalk(0.16);
  const stalkL = mkStalk(-0.16);

  const mkClaw = (x: number, big: boolean): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.02, 0.22);
    g.rotation.set(big ? BIG_REST : SMALL_REST, x > 0 ? -0.55 : 0.55, 0);
    body.add(g);
    const mesh = makeClaw(big);
    mesh.position.set(x > 0 ? -0.05 : -0.05, -0.10, -0.05);
    g.add(mesh);
    return g;
  };
  const clawBig = mkClaw(0.34, true);
  const clawSmall = mkClaw(-0.32, false);

  const legs: Record<string, THREE.Group> = {};
  for (let i = 0; i < 3; i++) {
    const z = 0.10 - i * 0.20;
    for (const side of [1, -1]) {
      const g = new THREE.Group();
      g.position.set(side * 0.24, -0.06, z);
      g.rotation.set(LEG_REST[i], 0, side > 0 ? -LEG_SPLAY : LEG_SPLAY);
      body.add(g);
      const mesh = makeLeg(side);
      mesh.position.set(side > 0 ? 0 : -0.05, -0.05, -0.05);
      g.add(mesh);
      legs[(side > 0 ? LEG_R : LEG_L)[i]] = g;
    }
  }

  return {
    root,
    parts: {
      body, shell, stalkR, stalkL, clawBig, clawSmall,
      legR1: legs.legR1, legR2: legs.legR2, legR3: legs.legR3,
      legL1: legs.legL1, legL2: legs.legL2, legL3: legs.legL3,
    },
    height: 0.94,
    radius: 0.50,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.6);

  let bpx = 0, bpy = BODY_Y + 0.004 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsy = 1 + 0.010 * br;
  let shellLag = 0, shellRoll = 0;
  let bigOpen = 0, bigLift = 0, smallOpen = 0, smallLift = 0;
  let clawSweep = 0;
  // The scuttle: amplitude of the travelling wave, its phase step per leg pair,
  // and a crouch applied to every leg at once.
  let legAmp = 0, legStep = 1.5, legFreq = 1.0, crouch = 0, legLift = 0;
  let stalkAmp = 0.28, stalkFreq = 0.6, stalkTuck = 0;

  switch (ctx.action) {
    case 'idle': {
      bsy = 1 + 0.02 * br;
      // The claws work constantly — a hermit crab at rest is a hermit crab
      // tidying. Two mismatched frequencies so the pair never syncs.
      bigOpen = 0.20 * Math.max(0, Math.sin(t * 1.3)) ** 2;
      smallOpen = 0.26 * Math.max(0, Math.sin(t * 1.9 + 1.1)) ** 2;
      bigLift = 0.06 * Math.sin(t * 0.9);
      smallLift = 0.08 * Math.sin(t * 1.2 + 2);
      legAmp = 0.05;
      legFreq = 1.4;
      stalkAmp = 0.42;                                  // periscoping constantly
      stalkFreq = 0.5;
      shellLag = 0.05 * Math.sin(t * 0.8);
      break;
    }
    case 'walk':
    case 'run': {
      // A METACHRONAL WAVE: each leg pair a fixed phase behind the one in front,
      // so the motion runs down the body instead of the whole side lifting at
      // once. That is how every many-legged thing actually walks, and it is the
      // reason this rig has three pairs instead of two.
      const isRun = ctx.action === 'run';
      legFreq = (isRun ? 9 : 6.5) + 3.5 * ms;
      legAmp = (isRun ? 0.55 : 0.38) * (0.5 + 0.5 * ms);
      legStep = 1.7;
      const ph = ctx.cycle(GAIT, legFreq);
      // The body skitters SIDEWAYS across its own line of travel, which is the
      // crab read: a bob straight up and down would be any insect.
      bpx = 0.035 * Math.sin(ph * 0.5);
      bpy += 0.018 * Math.abs(Math.sin(ph));
      brz = 0.09 * Math.sin(ph * 0.5 - 0.4);
      bry = 0.06 * Math.sin(ph * 0.5 - 1.0);
      bsy = 1 + 0.018 * Math.sin(ph * 2);
      // The house rocks a beat behind the crab under it.
      shellLag = 0.13 * Math.sin(ph * 0.5 - 1.3);
      shellRoll = 0.10 * Math.sin(ph * 0.5 - 1.8);
      clawSweep = 0.16 * Math.sin(ph * 0.5 - 0.6);
      bigLift = 0.14 + 0.10 * Math.sin(ph * 0.5);
      smallLift = 0.12 + 0.12 * Math.sin(ph * 0.5 + 1.4);
      stalkAmp = 0.16;
      stalkFreq = legFreq * 0.25;
      break;
    }
    case 'swim':
    case 'fly': {
      // It does not swim so much as WALK ON THE WATER'S FLOOR AND BOB. The legs
      // paddle in the same travelling wave at half amplitude, the body hangs
      // nose-up, and the shell — full of air — floats it. Same GAIT slot as the
      // scuttle, so entering the water changes the rate and never the pose.
      legFreq = 4.5 + 3.0 * ms;
      legAmp = 0.42;
      legStep = 1.2;
      const ph = ctx.cycle(GAIT, legFreq);
      brx = -0.18 + 0.06 * Math.sin(ph * 0.5);
      bpy += 0.045 * Math.sin(ph * 0.5 - 0.7);
      brz = 0.12 * Math.sin(ph * 0.33);
      crouch = -0.25;                                    // legs hang down
      legLift = 0.10;
      shellLag = -0.14 + 0.07 * Math.sin(ph * 0.33);     // the shell rides high
      shellRoll = 0.09 * Math.sin(ph * 0.33 - 0.9);
      clawSweep = 0.22 * Math.sin(ph * 0.4);
      bigLift = 0.28 + 0.14 * Math.sin(ph * 0.4);        // claws sculling
      smallLift = 0.26 + 0.16 * Math.sin(ph * 0.4 + 1.6);
      stalkAmp = 0.24;
      stalkFreq = 1.2;
      break;
    }
    case 'attack': {
      // The snap. Everything is in the big claw: wind it back and open, then
      // drive it forward and shut, with the body twisting behind it.
      const wind = smooth(phase(at, 0, 0.16));
      const snap = ezOut(phase(at, 0.16, 0.27));
      const rec = smooth(phase(at, 0.4, 0.8));
      const k = -0.5 * wind * (1 - snap) + snap * (1 - rec);
      const kp = Math.max(0, k);
      bry = -0.30 * k;
      bpz = 0.14 * k;
      bpy += 0.02 * kp;
      bigOpen = 0.9 * wind * (1 - snap);                 // wide open, then shut
      bigLift = 0.5 * wind * (1 - snap) + 0.15 * kp;
      clawSweep = -0.7 * k;
      smallLift = 0.3 * kp;
      smallOpen = 0.3 * wind * (1 - snap);
      crouch = 0.18 * kp;
      stalkAmp = 0.10;
      stalkTuck = 0.3 * wind * (1 - snap);
      shellLag = 0.16 * k;
      break;
    }
    case 'cast': {
      // Both claws up and open, held wide — the pose of a crab making itself
      // enormous, borrowed for a cast because it is the one thing this shape
      // does that reads as a declaration.
      const rise = ezOut(clamp01(at / 0.35));
      const hum = 0.5 * Math.sin(t * 11) + 0.5 * Math.sin(t * 17);
      brx = -0.22 * rise;
      bpy += 0.06 * rise;
      bigLift = 1.15 * rise + 0.05 * hum * rise;
      smallLift = 1.05 * rise + 0.05 * hum * rise;
      bigOpen = 0.55 * rise + 0.12 * Math.sin(t * 8) * rise;
      smallOpen = 0.55 * rise + 0.12 * Math.sin(t * 8 + Math.PI) * rise;
      clawSweep = 0.35 * rise;
      crouch = -0.20 * rise;                             // stands tall
      legAmp = 0.06;
      legFreq = 5;
      stalkAmp = 0.34;
      stalkFreq = 4;
      shellLag = -0.18 * rise;
      break;
    }
    case 'special': {
      // A spinning sand-scour: the whole animal turns on the spot with both
      // claws out, legs churning. About Y, because a crab that rolls is a crab
      // on its back.
      const T = 0.85;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.24))
        * (1 - smooth(phase(at, T + 0.24, T + 0.6)));
      bry = Math.PI * 6 * smooth(k2);
      bpy += 0.10 * spin;
      bsy = 1 - 0.12 * land;
      bigLift = 0.9 * spin + 0.2 * land;
      smallLift = 0.85 * spin + 0.2 * land;
      clawSweep = 0.8 * spin;
      bigOpen = 0.35 * spin;
      smallOpen = 0.35 * spin;
      legAmp = 0.6 * spin + 0.2;
      legFreq = 16;
      legStep = 2.2;
      crouch = 0.22 * spin;
      stalkAmp = 0.12;
      stalkTuck = 0.5 * spin;
      shellRoll = 0.22 * Math.sin(at * 12) * spin;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.6 * at);
      bpx = 0.035 * Math.sin(at * 42) * d;
      bpz = -0.07 * d;
      bpy -= 0.05 * d;
      brz = 0.09 * Math.sin(at * 34 + 1) * d;
      // It pulls INTO the shell: the stalks fold flat, the claws clamp across
      // the front, the legs draw under. Same instinct as Coralback's withdraw,
      // and the same reason it is the whole animation.
      stalkTuck = 1.0 * d;
      stalkAmp = 0.05;
      bigLift = -0.5 * d;
      smallLift = -0.5 * d;
      clawSweep = -0.6 * d;
      crouch = 0.55 * d;
      shellLag = 0.24 * d;
      bsy = 1 - 0.06 * d;
      break;
    }
    case 'happy': {
      // Both claws waving overhead on alternate beats while it bounces — the
      // one gesture a crab has that is unmistakably delight rather than threat,
      // because the claws are open and NOT pointed at anything.
      const hf = 6.5;
      const hop = Math.abs(Math.sin(at * hf * 0.5));
      bpy += 0.07 * hop;
      bsy = 0.94 + 0.12 * hop;
      bry = 0.28 * Math.sin(at * 2.4);
      bigLift = 0.75 + 0.35 * Math.sin(at * hf);
      smallLift = 0.75 + 0.35 * Math.sin(at * hf + Math.PI);
      bigOpen = 0.45 + 0.25 * Math.sin(at * hf);
      smallOpen = 0.45 + 0.25 * Math.sin(at * hf + Math.PI);
      clawSweep = 0.3 * Math.sin(at * 2.4 + 1);
      legAmp = 0.22;
      legFreq = 11;
      stalkAmp = 0.5;
      stalkFreq = 7;
      shellRoll = 0.14 * Math.sin(at * 4.8);
      shellLag = 0.10 * Math.sin(at * 4.8 - 0.8);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.shell.rotation.set(-0.34 + shellLag, 0.4, shellRoll);

  // The claws. `sweep` swings them across the front (rotY), `lift` raises them
  // (rotX) and `open` is the gape — which is the same rotX applied to the whole
  // arm, because the jaws are one mesh: opening a pincer at this cell size has
  // to be read off the arm's angle against the body rather than off a hinge.
  p.clawBig.rotation.set(BIG_REST - bigLift - bigOpen * 0.4, -0.55 + clawSweep, 0);
  p.clawSmall.rotation.set(SMALL_REST - smallLift - smallOpen * 0.4, 0.55 - clawSweep * 0.8, 0);

  // ONE cycle() call for the pair. A slot is per-beast state and must be read at
  // most once a frame (see BeastAnimCtx.cycle); the left stalk takes the same
  // phase with a constant offset, which is what keeps the two from ever
  // swivelling in lockstep without a second slot.
  const sw = ctx.cycle(STALKW, stalkFreq);
  p.stalkR.rotation.set(-stalkTuck * 1.2, stalkAmp * Math.sin(sw), -stalkTuck * 0.5);
  p.stalkL.rotation.set(-stalkTuck * 1.2, -stalkAmp * Math.sin(sw + 0.9), stalkTuck * 0.5);

  // Six legs off ONE integrated phase, each pair `legStep` radians behind the
  // one in front. Left and right run half a period apart so opposite sides
  // alternate, which is what keeps it upright.
  const gw = ctx.cycle(GAIT, legFreq);
  for (let i = 0; i < 3; i++) {
    const ph = gw - i * legStep;
    const swingR = legAmp * Math.sin(ph);
    const swingL = legAmp * Math.sin(ph + Math.PI);
    p[LEG_R[i]].rotation.set(
      LEG_REST[i] + swingR + crouch, 0, -LEG_SPLAY - legLift - Math.abs(swingR) * 0.4);
    p[LEG_L[i]].rotation.set(
      LEG_REST[i] + swingL + crouch, 0, LEG_SPLAY + legLift + Math.abs(swingL) * 0.4);
  }
}

export const skills: SkillDef[] = [
  {
    id: 'snapclaw.pincer-snap',
    nameKey: 'skill.snapclaw.pincer-snap.name',
    descriptionKey: 'skill.snapclaw.pincer-snap.desc',
    element: 'rock',
    targeting: 'melee',
    cost: 5,
    cooldown: 1.5,
    power: 15,
    range: 3.2,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'snapclaw.sand-spray',
    nameKey: 'skill.snapclaw.sand-spray.name',
    descriptionKey: 'skill.snapclaw.sand-spray.desc',
    element: 'rock',
    targeting: 'aoe',
    cost: 12,
    cooldown: 5,
    power: 18,
    range: 4.0,
    learnAtLevel: 4,
    castAnim: 'special',
  },
  {
    id: 'snapclaw.shell-up',
    nameKey: 'skill.snapclaw.shell-up.name',
    descriptionKey: 'skill.snapclaw.shell-up.desc',
    element: 'rock',
    targeting: 'support',
    cost: 16,
    cooldown: 9,
    power: 22,
    range: 6,
    storePrice: 230,
    castAnim: 'cast',
  },
  {
    id: 'snapclaw.brine-shot',
    nameKey: 'skill.snapclaw.brine-shot.name',
    descriptionKey: 'skill.snapclaw.brine-shot.desc',
    element: 'water',
    targeting: 'projectile',
    cost: 14,
    cooldown: 4.2,
    power: 26,
    range: 14,
    storePrice: 290,
    castAnim: 'cast',
  },
];

export const species: BeastSpecies = {
  id: 'snapclaw',
  nameKey: 'beast.snapclaw.name',
  descriptionKey: 'beast.snapclaw.desc',
  element: 'rock',
  locomotion: 'amphibious',
  // The bruiser of the water roster: the highest attack of the five, bought
  // with a speed that gallops at 6.7 — under a sprint on land, 11.5 in water.
  // It crosses the deep, it just does not hurry.
  baseStats: { maxHp: 62, attack: 14, defense: 12, speed: 3.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
