import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { rimTop, shadeUnder } from "./voxelshade";

// Snapclaw — hermit crab, rock-typed amphibian. Voxel scale 0.1 (1 cell = 10 cm),
// faces +Z, root at ground/water level. Scuttles on a metachronal leg wave, not
// diagonal pairs. No eyes2x2: the eyes are beads on stalks, see makeEyestalk.

const S = 0.1;

const CHITIN = 0xd4653c;
const CHITIN_LIT = 0xf1976a;
const CHITIN_DARK = 0x8f3d22;
const CLAW = 0xe0764a;
const CLAW_TIP = 0xfbd9b0;
const SHELL = 0xa8a294;
const SHELL_LIT = 0xd0cabb;
const SHELL_DARK = 0x6f6a5f;
const SHELL_BAND = 0x7f8f96;
const EYE = 0x1b1410;
const EYE_SHINE = 0xfff4e2;
const STALK = 0xc4562f;

// Must match buildRig
const BODY_Y = 0.26;
/** Rest crouch of the six legs, front to back along each side. */
const LEG_REST: readonly number[] = [-0.34, 0, 0.34];
const LEG_SPLAY = 0.62;
const BIG_REST = -0.3;
const SMALL_REST = -0.16;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// Cycle slots — see BeastAnimCtx.cycle().
const GAIT = 0;
const STALKW = 1;

const LEG_R = ["legR1", "legR2", "legR3"] as const;
const LEG_L = ["legL1", "legL2", "legL3"] as const;

function makeCarapace(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.6, 0, 5.6, 1.8, 3.6, CHITIN);
  m.ellipsoid(0, 0.6, 0.4, 4.6, 0.9, 2.8, CHITIN_DARK);
  m.box(-2, 3, 3, -1, 3, 3, CHITIN_LIT);
  m.box(1, 3, 3, 2, 3, 3, CHITIN_LIT);
  m.box(-1, 1, 4, 1, 1, 4, CHITIN_DARK);
  shadeUnder(m, CHITIN_DARK, -6, 6, 0, 2, -4, 4);
  rimTop(m, CHITIN_LIT, -6, 6, 1, 4, -4, 4);
  return m.build(S, true);
}

function makeShell(): THREE.Mesh {
  const m = new VoxelModel();
  // Four stacked rings, banded and turned a sixth per ring: a real helix at 1-cell
  // resolution comes out as a lumpy sausage.
  const rings: Array<[number, number, number]> = [
    [0.0, 4.2, 0],
    [2.2, 3.4, 1],
    [4.0, 2.4, 2],
    [5.4, 1.4, 3],
  ];
  for (const [y, r, i] of rings) {
    m.ellipsoid(0, y, -i * 0.5, r, 1.5, r, SHELL);
    const a = i * 1.05;
    const bx = Math.round(Math.cos(a) * (r - 0.6));
    const bz = Math.round(Math.sin(a) * (r - 0.6));
    for (let dy = 0; dy <= 1; dy++) {
      if (m.has(bx, Math.round(y) + dy, bz)) {
        m.set(bx, Math.round(y) + dy, bz, SHELL_BAND);
      }
      if (m.has(-bx, Math.round(y) + dy, -bz)) {
        m.set(-bx, Math.round(y) + dy, -bz, SHELL_BAND);
      }
    }
  }
  m.set(0, 7, -2, SHELL_LIT);
  shadeUnder(m, SHELL_DARK, -5, 5, 0, 2, -5, 5);
  rimTop(m, SHELL_LIT, -5, 5, 2, 8, -5, 5);
  return m.build(S, true);
}

function makeEyestalk(): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, STALK);
  m.set(0, 1, 0, STALK);
  m.set(0, 2, 0, EYE);
  // Catchlight on the FRONT of the bead, not the top: the follow camera looks down.
  m.set(0, 2, 1, EYE_SHINE);
  return m.build(S, false);
}

function makeClaw(big: boolean): THREE.Mesh {
  const m = new VoxelModel();
  const w = big ? 2 : 1;
  const l = big ? 4 : 3;
  m.box(0, 0, 0, 1, 1, 1, CHITIN);
  m.ellipsoid(0, 1, -(l - 1), w, 1.4, l * 0.6, CLAW);
  // Upper and lower blade with a gap: a solid block reads as a mitten.
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
 * `dir` is +1 for a leg growing toward +X. Mirrored by PAINTING the other way, never
 * `scale.x = -1`: a negative scale flips winding, so that side lights from the wrong
 * hemisphere. Same rule as Aquaxol's gill fronds.
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
  carapace.position.set(0, -0.1, 0);
  body.add(carapace);

  // Own group, and it lags the body in every gait: a borrowed house, not part of it.
  const shell = new THREE.Group();
  shell.position.set(0, 0.1, -0.24);
  shell.rotation.set(-0.34, 0.4, 0);
  body.add(shell);
  const shellMesh = makeShell();
  shellMesh.position.set(0, 0.06, -0.1);
  shell.add(shellMesh);

  const mkStalk = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.22, 0.3);
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
    mesh.position.set(x > 0 ? -0.05 : -0.05, -0.1, -0.05);
    g.add(mesh);
    return g;
  };
  const clawBig = mkClaw(0.34, true);
  const clawSmall = mkClaw(-0.32, false);

  const legs: Record<string, THREE.Group> = {};
  for (let i = 0; i < 3; i++) {
    const z = 0.1 - i * 0.2;
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
      body,
      shell,
      stalkR,
      stalkL,
      clawBig,
      clawSmall,
      legR1: legs.legR1,
      legR2: legs.legR2,
      legR3: legs.legR3,
      legL1: legs.legL1,
      legL2: legs.legL2,
      legL3: legs.legL3,
    },
    height: 0.94,
    radius: 0.5,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.6);

  let bpx = 0,
    bpy = BODY_Y + 0.004 * br,
    bpz = 0;
  let brx = 0,
    bry = 0,
    brz = 0;
  let bsy = 1 + 0.01 * br;
  let shellLag = 0,
    shellRoll = 0;
  let bigOpen = 0,
    bigLift = 0,
    smallOpen = 0,
    smallLift = 0;
  let clawSweep = 0;
  let legAmp = 0,
    legStep = 1.5,
    legFreq = 1.0,
    crouch = 0,
    legLift = 0;
  let stalkAmp = 0.28,
    stalkFreq = 0.6,
    stalkTuck = 0;

  switch (ctx.action) {
    case "idle": {
      bsy = 1 + 0.02 * br;
      bigOpen = 0.2 * Math.max(0, Math.sin(t * 1.3)) ** 2;
      smallOpen = 0.26 * Math.max(0, Math.sin(t * 1.9 + 1.1)) ** 2;
      bigLift = 0.06 * Math.sin(t * 0.9);
      smallLift = 0.08 * Math.sin(t * 1.2 + 2);
      legAmp = 0.05;
      legFreq = 1.4;
      stalkAmp = 0.42;
      stalkFreq = 0.5;
      shellLag = 0.05 * Math.sin(t * 0.8);
      break;
    }
    case "walk":
    case "run": {
      const isRun = ctx.action === "run";
      legFreq = (isRun ? 9 : 6.5) + 3.5 * ms;
      legAmp = (isRun ? 0.55 : 0.38) * (0.5 + 0.5 * ms);
      legStep = 1.7;
      const ph = ctx.cycle(GAIT, legFreq);
      bpx = 0.035 * Math.sin(ph * 0.5);
      bpy += 0.018 * Math.abs(Math.sin(ph));
      brz = 0.09 * Math.sin(ph * 0.5 - 0.4);
      bry = 0.06 * Math.sin(ph * 0.5 - 1.0);
      bsy = 1 + 0.018 * Math.sin(ph * 2);
      shellLag = 0.13 * Math.sin(ph * 0.5 - 1.3);
      shellRoll = 0.1 * Math.sin(ph * 0.5 - 1.8);
      clawSweep = 0.16 * Math.sin(ph * 0.5 - 0.6);
      bigLift = 0.14 + 0.1 * Math.sin(ph * 0.5);
      smallLift = 0.12 + 0.12 * Math.sin(ph * 0.5 + 1.4);
      stalkAmp = 0.16;
      stalkFreq = legFreq * 0.25;
      break;
    }
    case "swim":
    case "fly": {
      legFreq = 4.5 + 3.0 * ms;
      legAmp = 0.42;
      legStep = 1.2;
      const ph = ctx.cycle(GAIT, legFreq);
      brx = -0.18 + 0.06 * Math.sin(ph * 0.5);
      bpy += 0.045 * Math.sin(ph * 0.5 - 0.7);
      brz = 0.12 * Math.sin(ph * 0.33);
      crouch = -0.25;
      legLift = 0.1;
      shellLag = -0.14 + 0.07 * Math.sin(ph * 0.33);
      shellRoll = 0.09 * Math.sin(ph * 0.33 - 0.9);
      clawSweep = 0.22 * Math.sin(ph * 0.4);
      bigLift = 0.28 + 0.14 * Math.sin(ph * 0.4);
      smallLift = 0.26 + 0.16 * Math.sin(ph * 0.4 + 1.6);
      stalkAmp = 0.24;
      stalkFreq = 1.2;
      break;
    }
    case "attack": {
      const wind = smooth(phase(at, 0, 0.16));
      const snap = ezOut(phase(at, 0.16, 0.27));
      const rec = smooth(phase(at, 0.4, 0.8));
      const k = -0.5 * wind * (1 - snap) + snap * (1 - rec);
      const kp = Math.max(0, k);
      bry = -0.3 * k;
      bpz = 0.14 * k;
      bpy += 0.02 * kp;
      bigOpen = 0.9 * wind * (1 - snap);
      bigLift = 0.5 * wind * (1 - snap) + 0.15 * kp;
      clawSweep = -0.7 * k;
      smallLift = 0.3 * kp;
      smallOpen = 0.3 * wind * (1 - snap);
      crouch = 0.18 * kp;
      stalkAmp = 0.1;
      stalkTuck = 0.3 * wind * (1 - snap);
      shellLag = 0.16 * k;
      break;
    }
    case "cast": {
      const rise = ezOut(clamp01(at / 0.35));
      const hum = 0.5 * Math.sin(t * 11) + 0.5 * Math.sin(t * 17);
      brx = -0.22 * rise;
      bpy += 0.06 * rise;
      bigLift = 1.15 * rise + 0.05 * hum * rise;
      smallLift = 1.05 * rise + 0.05 * hum * rise;
      bigOpen = 0.55 * rise + 0.12 * Math.sin(t * 8) * rise;
      smallOpen = 0.55 * rise + 0.12 * Math.sin(t * 8 + Math.PI) * rise;
      clawSweep = 0.35 * rise;
      crouch = -0.2 * rise;
      legAmp = 0.06;
      legFreq = 5;
      stalkAmp = 0.34;
      stalkFreq = 4;
      shellLag = -0.18 * rise;
      break;
    }
    case "special": {
      const T = 0.85;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const land =
        Math.sin(Math.PI * phase(at, T, T + 0.24)) * (1 - smooth(phase(at, T + 0.24, T + 0.6)));
      bry = Math.PI * 6 * smooth(k2);
      bpy += 0.1 * spin;
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
    case "hurt": {
      const d = Math.exp(-3.6 * at);
      bpx = 0.035 * Math.sin(at * 42) * d;
      bpz = -0.07 * d;
      bpy -= 0.05 * d;
      brz = 0.09 * Math.sin(at * 34 + 1) * d;
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
    case "happy": {
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
      shellLag = 0.1 * Math.sin(at * 4.8 - 0.8);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.shell.rotation.set(-0.34 + shellLag, 0.4, shellRoll);

  // `open` is more arm rotX, not a hinge: the jaws are one mesh, so the gape has to be
  // read off the arm's angle against the body at this cell size.
  p.clawBig.rotation.set(BIG_REST - bigLift - bigOpen * 0.4, -0.55 + clawSweep, 0);
  p.clawSmall.rotation.set(SMALL_REST - smallLift - smallOpen * 0.4, 0.55 - clawSweep * 0.8, 0);

  // ONE cycle() call for the pair — a slot is per-beast state, read at most once a
  // frame; the left stalk takes the same phase with a constant offset.
  const sw = ctx.cycle(STALKW, stalkFreq);
  p.stalkR.rotation.set(-stalkTuck * 1.2, stalkAmp * Math.sin(sw), -stalkTuck * 0.5);
  p.stalkL.rotation.set(-stalkTuck * 1.2, -stalkAmp * Math.sin(sw + 0.9), stalkTuck * 0.5);

  // Six legs off one phase, each pair `legStep` behind the one in front; sides run half
  // a period apart, which is what keeps it upright.
  const gw = ctx.cycle(GAIT, legFreq);
  for (let i = 0; i < 3; i++) {
    const ph = gw - i * legStep;
    const swingR = legAmp * Math.sin(ph);
    const swingL = legAmp * Math.sin(ph + Math.PI);
    p[LEG_R[i]].rotation.set(
      LEG_REST[i] + swingR + crouch,
      0,
      -LEG_SPLAY - legLift - Math.abs(swingR) * 0.4,
    );
    p[LEG_L[i]].rotation.set(
      LEG_REST[i] + swingL + crouch,
      0,
      LEG_SPLAY + legLift + Math.abs(swingL) * 0.4,
    );
  }
}

export const skills: SkillDef[] = [
  {
    id: "snapclaw.pincer-snap",
    nameKey: "skill.snapclaw.pincer-snap.name",
    descriptionKey: "skill.snapclaw.pincer-snap.desc",
    element: "rock",
    targeting: "melee",
    cost: 5,
    cooldown: 1.5,
    power: 15,
    range: 3.2,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "snapclaw.sand-spray",
    nameKey: "skill.snapclaw.sand-spray.name",
    descriptionKey: "skill.snapclaw.sand-spray.desc",
    element: "rock",
    targeting: "aoe",
    cost: 12,
    cooldown: 5,
    power: 18,
    range: 4.0,
    learnAtLevel: 4,
    castAnim: "special",
  },
  {
    id: "snapclaw.shell-up",
    nameKey: "skill.snapclaw.shell-up.name",
    descriptionKey: "skill.snapclaw.shell-up.desc",
    element: "rock",
    targeting: "support",
    cost: 16,
    cooldown: 9,
    power: 22,
    range: 6,
    storePrice: 230,
    castAnim: "cast",
  },
  {
    id: "snapclaw.brine-shot",
    nameKey: "skill.snapclaw.brine-shot.name",
    descriptionKey: "skill.snapclaw.brine-shot.desc",
    element: "water",
    targeting: "projectile",
    cost: 14,
    cooldown: 4.2,
    power: 26,
    range: 14,
    storePrice: 290,
    castAnim: "cast",
  },
];

export const species: BeastSpecies = {
  id: "snapclaw",
  nameKey: "beast.snapclaw.name",
  descriptionKey: "beast.snapclaw.desc",
  element: "rock",
  locomotion: "amphibious",
  // Highest attack of the water five, bought with a 6.7 gallop and 11.5 in water.
  baseStats: { maxHp: 62, attack: 14, defense: 12, speed: 3.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
