import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";

// Coralback — sea turtle, the water tank. Voxel scale 0.1 (1 cell = 10 cm), faces +Z,
// root at ground/water level. The same flippers plod on land and fly in water.

const S = 0.1;

const SHELL = 0x3f6b5c;
const SHELL_LIT = 0x63977f;
const SHELL_DARK = 0x27443c;
const SCUTE = 0x8fbf9c;
const SKIN = 0x7d8f7a;
const SKIN_LIT = 0xa4b49c;
const SKIN_DARK = 0x4e5c4d;
const PLASTRON = 0xd7cfa8;
const CORAL = 0xf2856b;
const CORAL_LIT = 0xffb08e;
const IRIS = 0x1d2a24;
const SHINE = 0xf2fff8;

// Must match buildRig
const BODY_Y = 0.34;
const NECK_Z = 0.62;
const FLIP_SPLAY = 0.42;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// Cycle slots — see BeastAnimCtx.cycle().
const GAIT = 0;
const CORALW = 1;

function makeShell(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 0.6, 0, 5.0, 4.2, 5.8, SHELL);
  m.ellipsoid(0, 0.2, 0, 5.6, 1.1, 5.6, SHELL_DARK);
  // Scute seams are painted cells, not carved: build() bakes only a per-face shade.
  for (const [sx, sz] of [
    [0, 3],
    [0, -3],
    [3, 0],
    [-3, 0],
    [2, 2],
    [-2, 2],
    [2, -2],
    [-2, -2],
  ]) {
    for (let y = 3; y <= 5; y++) {
      if (m.has(sx, y, sz)) {
        m.set(sx, y, sz, SCUTE);
        break;
      }
    }
  }
  rimTop(m, SHELL_LIT, -2, 2, 3, 6, -2, 2);
  return m.build(S, true);
}

function makeCoral(kind: 0 | 1 | 2): THREE.Mesh {
  const m = new VoxelModel();
  if (kind === 0) {
    m.box(0, 0, 0, 0, 3, 0, CORAL);
    m.set(1, 3, 0, CORAL);
    m.set(1, 4, 0, CORAL_LIT);
    m.set(-1, 2, 0, CORAL);
    m.set(-1, 3, 0, CORAL_LIT);
    m.set(0, 4, 0, CORAL_LIT);
  } else if (kind === 1) {
    m.ellipsoid(0, 1, 0, 1.6, 1.4, 1.6, CORAL);
    rimTop(m, CORAL_LIT, -2, 2, 0, 3, -2, 2);
  } else {
    m.box(0, 0, 0, 0, 1, 0, CORAL);
    m.box(-2, 2, 0, 2, 3, 0, CORAL);
    m.set(-2, 3, 0, CORAL_LIT);
    m.set(2, 3, 0, CORAL_LIT);
    m.set(0, 4, 0, CORAL_LIT);
  }
  return m.build(S, false);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, 0.4, 2.4, 2.1, 2.6, SKIN);
  m.box(-2, 1, 3, 2, 4, 3, SKIN);
  m.ellipsoid(0, 0.6, 1.4, 2.3, 1.0, 2.0, PLASTRON);
  m.box(-1, 1, 4, 1, 2, 4, PLASTRON);
  m.set(0, 1, 5, SKIN_DARK);
  rimTop(m, SKIN_LIT, -2, 2, 0, 5, -2, 4);
  eyes2x2(m, {
    inner: 1,
    width: 1,
    y: 3,
    faceZ: 3,
    iris: IRIS,
    shine: SHINE,
    lid: SKIN_DARK,
    bridge: SKIN_LIT,
    browProud: true,
  });
  return m.build(S, true);
}

function makeFlipper(front: boolean): THREE.Mesh {
  const m = new VoxelModel();
  const len = front ? 5 : 3;
  for (let i = 0; i <= len; i++) {
    const w = front ? Math.min(2, 1 + Math.floor(i / 2)) : 1;
    m.box(-w, 0, -i, w, 0, -i, SKIN);
  }
  m.box(-1, 1, 0, 1, 1, -1, SKIN_LIT);
  shadeUnder(m, SKIN_DARK, -3, 3, 0, 1, -6, 1);
  return m.build(S, false);
}

function makeNeck(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.2, 0, 1.7, 1.3, 2.0, SKIN);
  shadeUnder(m, SKIN_DARK, -2, 2, 0, 2, -3, 3);
  return m.build(S, true);
}

function makeTail(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 0.8, -1.2, 1.0, 0.9, 1.8, SKIN);
  return m.build(S, true);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const shell = new THREE.Group();
  body.add(shell);
  const shellMesh = makeShell();
  shellMesh.position.set(0, 0.1, -0.04);
  shell.add(shellMesh);

  // One group per sprig so the current can move them at different phases.
  const coral: Record<string, THREE.Group> = {};
  const sprigs: Array<[string, 0 | 1 | 2, number, number, number]> = [
    ["coralA", 0, 0.1, 0.46, -0.1],
    ["coralB", 1, -0.22, 0.4, 0.14],
    ["coralC", 2, -0.04, 0.42, 0.3],
  ];
  for (const [name, kind, x, y, z] of sprigs) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    shell.add(g);
    g.add(makeCoral(kind));
    coral[name] = g;
  }

  const neck = new THREE.Group();
  neck.position.set(0, -0.06, NECK_Z);
  body.add(neck);
  const neckMesh = makeNeck();
  neckMesh.position.set(0, -0.1, 0.04);
  neck.add(neckMesh);

  const head = new THREE.Group();
  head.position.set(0, 0.16, 0.24);
  neck.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.12, 0.02);
  head.add(headMesh);

  const mkFlipper = (x: number, z: number, front: boolean): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.14, z);
    g.rotation.set(0, x > 0 ? -FLIP_SPLAY : FLIP_SPLAY, x > 0 ? -0.18 : 0.18);
    body.add(g);
    g.add(makeFlipper(front));
    return g;
  };
  const flipFL = mkFlipper(0.34, 0.26, true);
  const flipFR = mkFlipper(-0.34, 0.26, true);
  const flipBL = mkFlipper(0.3, -0.3, false);
  const flipBR = mkFlipper(-0.3, -0.3, false);

  const tail = new THREE.Group();
  tail.position.set(0, -0.04, -0.46);
  body.add(tail);
  const tailMesh = makeTail();
  tailMesh.position.set(0, -0.08, -0.1);
  tail.add(tailMesh);

  return {
    root,
    parts: {
      body,
      shell,
      neck,
      head,
      flipFL,
      flipFR,
      flipBL,
      flipBR,
      tail,
      coralA: coral.coralA,
      coralB: coral.coralB,
      coralC: coral.coralC,
    },
    height: 0.9,
    radius: 0.62,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 1.5);

  let bpx = 0,
    bpy = BODY_Y + 0.006 * br,
    bpz = 0;
  let brx = 0,
    bry = 0,
    brz = 0;
  let bsy = 1 + 0.01 * br;
  let nrx = 0,
    nry = 0,
    npz = NECK_Z;
  let hrx = 0,
    hry = 0,
    hrz = 0;
  // Front pair: sweep is rotY at the shoulder, lift rotZ. Back pair paddles only.
  let fSweep = 0,
    fLift = 0,
    fSplit = 0,
    bSweep = 0;
  let tailY = 0,
    tailX = 0;
  let coralSway = 0.07,
    coralFreq = 1.1;

  switch (ctx.action) {
    case "idle": {
      bsy = 1 + 0.024 * br;
      nrx = 0.06 * Math.sin(t * 0.9);
      // Withdraw goes BACK, never back-and-up: pitching the neck drove the skull
      // through the dome (0.0064 m2 of coincident face in test-zfight). The rim hides it.
      const tuck = 0.85 * Math.max(0, Math.sin(t * 0.19 + 0.6)) ** 14;
      npz = NECK_Z - 0.38 * tuck;
      nrx += 0.16 * tuck;
      hrx = -0.14 * tuck;
      hry = 0.3 * Math.sin(t * 0.23) * (1 - tuck);
      hrz = 0.05 * Math.sin(t * 0.6);
      fLift = -0.2 * tuck;
      tailY = 0.1 * Math.sin(t * 0.7);
      coralSway = 0.1;
      break;
    }
    case "walk":
    case "run": {
      const isRun = ctx.action === "run";
      const f = (isRun ? 4.6 : 3.2) + 1.8 * ms;
      const ph = ctx.cycle(GAIT, f);
      const amp = (isRun ? 0.62 : 0.45) * (0.5 + 0.5 * ms);
      fSweep = amp * Math.sin(ph);
      fSplit = amp * 0.9;
      bSweep = amp * 0.8 * Math.sin(ph + Math.PI);
      brz = 0.14 * Math.sin(ph - 0.5);
      bry = 0.05 * Math.sin(ph - 0.9);
      bpy += 0.026 * Math.abs(Math.sin(ph));
      bsy = 1 + 0.02 * Math.sin(ph * 2);
      nrx = -0.1 - 0.06 * Math.sin(ph);
      hrx = 0.07 * Math.sin(ph * 2 + 0.4);
      hrz = -0.09 * Math.sin(ph - 0.5);
      tailY = 0.18 * Math.sin(ph - 1.2);
      coralSway = 0.09;
      coralFreq = f * 0.6;
      break;
    }
    case "swim":
    case "fly": {
      // Same GAIT slot as the plod, so entering water changes the rate, not the pose.
      const f = 2.4 + 2.2 * ms;
      const ph = ctx.cycle(GAIT, f);
      const beat = Math.sin(ph);
      fSweep = 0.3 + 0.25 * beat;
      fLift = 0.85 * beat;
      fSplit = 0;
      bSweep = 0.18 * Math.sin(ph - 0.8);
      brx = -0.05 + 0.1 * Math.sin(ph - 0.6);
      bpy += 0.05 * Math.sin(ph - 1.0);
      brz = 0.07 * Math.sin(ph * 0.5);
      nrx = -0.14;
      hrx = -0.05 + 0.04 * Math.sin(ph);
      hry = 0.06 * Math.sin(ph * 0.5 + 0.6);
      tailX = 0.1 * Math.sin(ph - 1.4);
      coralSway = 0.16;
      coralFreq = 2.2;
      break;
    }
    case "attack": {
      const wind = smooth(phase(at, 0, 0.18));
      const shove = ezOut(phase(at, 0.18, 0.34));
      const rec = smooth(phase(at, 0.5, 0.9));
      const k = -0.5 * wind * (1 - shove) + shove * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.24 * k;
      brx = -0.16 * k;
      bpy += 0.03 * kp;
      npz = NECK_Z - 0.16 * kp;
      nrx = 0.3 * kp;
      hrx = -0.18 * kp;
      fSweep = -0.5 * kp + 0.4 * wind * (1 - shove);
      fLift = 0.5 * kp;
      bSweep = 0.6 * kp;
      tailY = -0.2 * k;
      break;
    }
    case "cast": {
      const rise = ezOut(clamp01(at / 0.45));
      const hum = 0.5 * Math.sin(t * 10) + 0.5 * Math.sin(t * 15);
      brx = -0.42 * rise + 0.02 * hum * rise;
      bpy += 0.1 * rise;
      nrx = -0.3 * rise;
      hrx = 0.34 * rise;
      fSweep = -0.7 * rise;
      fLift = 0.7 * rise + 0.12 * Math.sin(t * 6) * rise;
      bSweep = 0.3 * rise;
      tailX = -0.25 * rise;
      coralSway = 0.1 + 0.4 * rise;
      coralFreq = 7;
      break;
    }
    case "special": {
      // Spins about Y, not Z: a turtle rolled onto its back is a different joke.
      const T = 0.95;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const land =
        Math.sin(Math.PI * phase(at, T, T + 0.3)) * (1 - smooth(phase(at, T + 0.3, T + 0.7)));
      bry = Math.PI * 4 * smooth(k2);
      bpy += 0.14 * spin;
      bsy = 1 - 0.16 * land;
      npz = NECK_Z - 0.42 * spin;
      nrx = 0.18 * spin;
      hrx = -0.16 * spin;
      fSweep = -0.9 * spin;
      fLift = -0.5 * spin + 0.4 * land;
      bSweep = -0.8 * spin;
      coralSway = 0.35;
      coralFreq = 9;
      break;
    }
    case "hurt": {
      const d = Math.exp(-3.2 * at);
      bpx = 0.03 * Math.sin(at * 36) * d;
      bpz = -0.06 * d;
      bpy -= 0.04 * d;
      brz = 0.06 * Math.sin(at * 30 + 1) * d;
      npz = NECK_Z - 0.42 * d;
      nrx = 0.18 * d;
      hrx = -0.16 * d;
      fLift = -0.55 * d;
      fSweep = -0.4 * d;
      bSweep = -0.4 * d;
      bsy = 1 - 0.05 * d;
      break;
    }
    case "happy": {
      const hf = 3.2;
      brz = 0.24 * Math.sin(at * hf);
      bry = 0.16 * Math.sin(at * hf * 0.5);
      bpy += 0.05 * Math.abs(Math.sin(at * hf));
      npz = NECK_Z + 0.1;
      nrx = -0.22;
      hrx = 0.2;
      hrz = 0.26 * Math.sin(at * hf + 0.8);
      fSweep = 0.35 * Math.sin(at * hf);
      fLift = 0.3 + 0.3 * Math.sin(at * hf * 2);
      bSweep = 0.25 * Math.sin(at * hf + Math.PI);
      tailY = 0.3 * Math.sin(at * hf * 1.5);
      coralSway = 0.22;
      coralFreq = 5;
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.neck.position.set(0, -0.06, npz);
  p.neck.rotation.set(nrx, nry, 0);
  p.head.rotation.set(hrx, hry, hrz);

  // fSplit mirrors on the front pair: one expression covers plod (diagonal) and beat.
  p.flipFL.rotation.set(0, -FLIP_SPLAY + fSweep + fSplit, -0.18 - fLift);
  p.flipFR.rotation.set(0, FLIP_SPLAY - fSweep + fSplit, 0.18 + fLift);
  p.flipBL.rotation.set(0, -FLIP_SPLAY + bSweep, -0.18 - fLift * 0.3);
  p.flipBR.rotation.set(0, FLIP_SPLAY - bSweep, 0.18 + fLift * 0.3);
  p.tail.rotation.set(tailX, tailY, 0);

  // Per-sprig phase offsets off one cycle, so the colony ripples rather than nods.
  const cw = ctx.cycle(CORALW, coralFreq);
  p.coralA.rotation.set(coralSway * Math.sin(cw), 0, coralSway * Math.sin(cw * 0.7 + 1.1));
  p.coralB.rotation.set(
    coralSway * 0.8 * Math.sin(cw + 1.9),
    0,
    coralSway * 0.8 * Math.sin(cw * 0.7 + 2.6),
  );
  p.coralC.rotation.set(
    coralSway * 1.1 * Math.sin(cw + 3.4),
    0,
    coralSway * 1.1 * Math.sin(cw * 0.7 + 0.4),
  );
}

export const skills: SkillDef[] = [
  {
    id: "coralback.shell-slam",
    nameKey: "skill.coralback.shell-slam.name",
    descriptionKey: "skill.coralback.shell-slam.desc",
    element: "water",
    targeting: "melee",
    cost: 6,
    cooldown: 1.8,
    power: 14,
    range: 3.0,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "coralback.brine-bubble",
    nameKey: "skill.coralback.brine-bubble.name",
    descriptionKey: "skill.coralback.brine-bubble.desc",
    element: "water",
    targeting: "projectile",
    cost: 9,
    cooldown: 3.2,
    power: 15,
    range: 13,
    learnAtLevel: 4,
    castAnim: "cast",
  },
  {
    id: "coralback.reef-guard",
    nameKey: "skill.coralback.reef-guard.name",
    descriptionKey: "skill.coralback.reef-guard.desc",
    element: "water",
    targeting: "support",
    cost: 18,
    cooldown: 10,
    power: 28,
    range: 7,
    storePrice: 260,
    castAnim: "cast",
  },
  {
    id: "coralback.tide-anchor",
    nameKey: "skill.coralback.tide-anchor.name",
    descriptionKey: "skill.coralback.tide-anchor.desc",
    element: "water",
    targeting: "aoe",
    cost: 22,
    cooldown: 9.5,
    power: 34,
    range: 4.6,
    storePrice: 340,
    castAnim: "special",
  },
];

export const species: BeastSpecies = {
  id: "coralback",
  nameKey: "beast.coralback.name",
  descriptionKey: "beast.coralback.desc",
  element: "water",
  locomotion: "amphibious",
  // Highest hp/defense in the roster, bought with a 5.6 gallop — slower than walking.
  baseStats: { maxHp: 78, attack: 8, defense: 15, speed: 3.0 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
