import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";

// Finnick — porpoise pup, pure swimmer (LAND_FLOP in player/mount.ts halves land pace).
// Voxel scale 0.1 (1 cell = 10 cm), faces +Z, root at water level. Tail joints are
// rotX, not rotY: a cetacean beats its fluke vertically.

const S = 0.1;

const BACK = 0x2f5f86;
const BACK_LIT = 0x5b93bd;
const BACK_DARK = 0x1c3c58;
const FLANK = 0x8fb9d4;
const BELLY = 0xeef6f8;
const FIN = 0x264f72;
const FIN_LIT = 0x4c86ae;
const IRIS = 0x102030;
const SHINE = 0xf6ffff;
const MOUTH = 0x1a3348;
const BLOW = 0x1b3b55;

// Must match buildRig
const BODY_Y = 0.42;
const HEAD_Z = 0.4;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

// Cycle slots — see BeastAnimCtx.cycle().
const GAIT = 0;
const PECT = 1;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2.6, 0.4, 2.6, 2.6, 4.6, BACK);
  m.ellipsoid(0, 2.4, -3.2, 1.8, 1.8, 2.4, BACK); // peduncle
  m.ellipsoid(0, 1.6, 0.6, 2.2, 1.7, 4.2, FLANK);
  m.ellipsoid(0, 1.0, 0.8, 1.8, 1.2, 3.8, BELLY);
  shadeUnder(m, BACK_DARK, -3, 3, 0, 2, -6, 6);
  rimTop(m, BACK_LIT, -3, 3, 3, 6, -6, 6);
  m.set(0, 5, 1, BLOW); // blowhole
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2.2, 0, 2.4, 2.2, 2.4, BACK); // melon
  m.ellipsoid(0, 1.2, 0.4, 2.0, 1.3, 2.2, BELLY);
  m.box(-2, 1, 2, 2, 4, 2, BACK);
  m.box(-1, 1, 3, 1, 2, 4, BELLY);
  m.set(0, 1, 5, BELLY);
  // Smile: outer two cells lifted, as Aquaxol does it; a straight bar reads as a slot.
  m.set(0, 1, 2, MOUTH);
  m.set(-1, 2, 2, MOUTH);
  m.set(1, 2, 2, MOUTH);
  rimTop(m, BACK_LIT, -2, 2, 2, 5, -2, 3);
  eyes2x2(m, {
    inner: 1,
    width: 1,
    y: 3,
    faceZ: 2,
    iris: IRIS,
    shine: SHINE,
    lid: BACK_DARK,
    bridge: FLANK,
  });
  return m.build(S, true);
}

function makeDorsal(): THREE.Mesh {
  const m = new VoxelModel();
  for (let y = 0; y <= 3; y++) {
    const back = Math.floor(y * 0.9);
    m.box(0, y, -back, 0, y, 1 - back, FIN);
  }
  m.set(0, 3, -3, FIN_LIT);
  rimTop(m, FIN_LIT, 0, 0, 0, 4, -4, 2);
  return m.build(S, false);
}

/** `dir` is +1 for the right side. */
function makePectoral(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  for (let i = 0; i <= 3; i++) {
    m.box(dir * i, 0, -i, dir * i, 0, 1 - Math.floor(i * 0.5), FIN);
  }
  m.set(dir * 3, 0, -3, FIN_LIT);
  return m.build(S, false);
}

/** Horizontal lobes — a mammal's fluke, not a fish's tail. */
function makeFluke(): THREE.Mesh {
  const m = new VoxelModel();
  for (let x = -4; x <= 4; x++) {
    const reach = 2 - Math.floor(Math.abs(x) * 0.35);
    m.box(x, 0, -reach, x, 0, 0, FIN);
  }
  m.box(-1, 0, 1, 1, 0, 1, FIN);
  rimTop(m, FIN_LIT, -5, 5, 0, 1, -3, 2);
  return m.build(S, false);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.24, 0.04);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, 0.02, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.14, 0.02);
  head.add(headMesh);

  const dorsal = new THREE.Group();
  dorsal.position.set(0, 0.38, -0.1);
  body.add(dorsal);
  const dorsalMesh = makeDorsal();
  dorsalMesh.position.set(-0.05, 0, 0);
  dorsal.add(dorsalMesh);

  const mkPect = (dir: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(dir * 0.2, -0.16, 0.16);
    g.rotation.set(0, dir * -0.35, dir * -0.3);
    body.add(g);
    g.add(makePectoral(dir));
    return g;
  };
  const pectR = mkPect(1);
  const pectL = mkPect(-1);

  // tailTip trails tailBase by a fixed phase in every gait — that lag is the thrust read.
  const tailBase = new THREE.Group();
  tailBase.position.set(0, -0.04, -0.42);
  body.add(tailBase);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.02, -0.3);
  tailBase.add(tailTip);
  const fluke = makeFluke();
  fluke.position.set(-0.05, -0.02, -0.1);
  tailTip.add(fluke);

  return {
    root,
    parts: { body, head, dorsal, pectR, pectL, tailBase, tailTip },
    height: 0.86,
    radius: 0.44,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 1.9);

  let bpx = 0,
    bpy = BODY_Y + 0.01 * br,
    bpz = 0;
  let brx = 0,
    bry = 0,
    brz = 0;
  let bsy = 1 + 0.01 * br;
  let hrx = 0,
    hry = 0,
    hrz = 0;
  let tbx = 0,
    tby = 0,
    ttx = 0,
    tty = 0;
  let pSweep = 0,
    pLift = 0,
    pSplit = 0;
  let dorsalTilt = 0;

  switch (ctx.action) {
    case "idle": {
      const hover = ctx.cycle(GAIT, 1.6);
      brx = -0.06 + 0.035 * Math.sin(hover);
      bpy += 0.028 * Math.sin(hover - 0.5);
      bsy = 1 + 0.02 * br;
      hry = 0.2 * Math.sin(t * 0.29);
      hrx = 0.06 * Math.sin(t * 1.1);
      hrz = 0.05 * Math.sin(t * 0.7);
      tbx = 0.1 * Math.sin(hover - 0.9);
      ttx = 0.16 * Math.sin(hover - 1.6);
      pSweep = 0.14 * Math.sin(ctx.cycle(PECT, 2.4));
      pLift = 0.1;
      break;
    }
    case "walk":
    case "run": {
      // Beached flopping, deliberately ungainly — it must agree with LAND_FLOP.
      const isRun = ctx.action === "run";
      const f = (isRun ? 4.4 : 3.2) + 2.0 * ms;
      const ph = ctx.cycle(GAIT, f);
      const flop = Math.sin(ph);
      const hop = Math.max(0, flop);
      bpy += (isRun ? 0.16 : 0.1) * hop;
      brx = -0.3 * hop + 0.14 * Math.min(0, flop);
      brz = 0.22 * Math.sin(ph * 0.5);
      bry = 0.1 * Math.sin(ph * 0.5 - 0.7);
      bsy = 1 + 0.05 * Math.sin(ph * 2 + 0.7);
      hrx = 0.24 * hop;
      hry = 0.1 * Math.sin(ph * 0.5);
      tbx = -0.42 * hop + 0.12;
      ttx = -0.55 * Math.max(0, Math.sin(ph - 0.7));
      pSweep = 0.5 * hop;
      pLift = -0.5 * hop;
      pSplit = 0.25 * Math.sin(ph * 0.5);
      dorsalTilt = 0.12 * Math.sin(ph * 0.5);
      break;
    }
    case "swim":
    case "fly": {
      const f = 3.2 + 4.0 * ms;
      const ph = ctx.cycle(GAIT, f);
      tbx = (0.3 + 0.22 * ms) * Math.sin(ph);
      ttx = (0.42 + 0.3 * ms) * Math.sin(ph - 0.85);
      brx = -0.03 + (0.1 + 0.06 * ms) * Math.sin(ph + 0.5);
      bpy += 0.05 * Math.sin(ph + 0.5);
      brz = 0.12 * Math.sin(ph * 0.33);
      bry = 0.05 * Math.sin(ph * 0.33 - 0.8);
      hrx = -0.04 + 0.05 * Math.sin(ph + 0.9);
      hry = 0.05 * Math.sin(ph * 0.33 + 0.4);
      // Pectorals steer, they do not row: own rate, not the fluke beat.
      const pw = ctx.cycle(PECT, f * 0.34);
      pSweep = -0.1 + 0.1 * Math.sin(pw);
      pLift = 0.16 + 0.1 * Math.sin(pw - 0.6);
      dorsalTilt = 0.05 * Math.sin(ph * 0.33);
      break;
    }
    case "attack": {
      const wind = smooth(phase(at, 0, 0.12));
      const rush = ezOut(phase(at, 0.12, 0.26));
      const rec = smooth(phase(at, 0.4, 0.75));
      const k = -0.6 * wind * (1 - rush) + rush * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.3 * k;
      brx = -0.22 * k;
      bpy += 0.05 * kp;
      hrx = 0.18 * k;
      tbx = -0.55 * k;
      ttx = -0.7 * k;
      pSweep = -0.6 * kp + 0.5 * wind * (1 - rush);
      pLift = 0.4 * kp;
      dorsalTilt = -0.2 * k;
      break;
    }
    case "cast": {
      // Two mismatched sines: a sustained note, not a shiver.
      const rise = ezOut(clamp01(at / 0.35));
      const song = 0.5 * Math.sin(t * 14) + 0.5 * Math.sin(t * 21);
      brx = -0.55 * rise + 0.025 * song * rise;
      bpy += 0.14 * rise;
      hrx = 0.2 * rise;
      hrz = 0.04 * song * rise;
      tbx = 0.45 * rise;
      ttx = 0.3 * rise + 0.1 * Math.sin(t * 8) * rise;
      pSweep = 0.45 * rise;
      pLift = -0.55 * rise + 0.12 * Math.sin(t * 7) * rise;
      dorsalTilt = 0.1 * Math.sin(t * 5) * rise;
      break;
    }
    case "special": {
      // Breach somersault: rotation about X (end over end), not Rivotter's barrel roll.
      const T = 0.9;
      const k2 = clamp01(at / T);
      const air = Math.sin(Math.PI * k2);
      const splash =
        Math.sin(Math.PI * phase(at, T, T + 0.26)) * (1 - smooth(phase(at, T + 0.26, T + 0.62)));
      brx = -Math.PI * 2 * smooth(k2);
      bpy += 0.55 * air;
      bsy = 1 - 0.14 * splash;
      hrx = 0.18 * air;
      tbx = 0.5 * Math.sin(at * 13) * air;
      ttx = 0.65 * Math.sin(at * 13 - 0.8) * air;
      pSweep = -0.7 * air + 0.4 * splash;
      pLift = 0.6 * air;
      dorsalTilt = 0.25 * Math.sin(at * 9) * air;
      break;
    }
    case "hurt": {
      const d = Math.exp(-3.8 * at);
      bpx = 0.045 * Math.sin(at * 44) * d;
      bpz = -0.1 * d;
      bpy -= 0.06 * d;
      brx = 0.18 * d;
      brz = 0.1 * Math.sin(at * 34 + 1) * d;
      hrx = -0.26 * d;
      tbx = 0.35 * d;
      ttx = 0.45 * d;
      pSweep = 0.35 * d;
      pLift = -0.3 * d;
      bsy = 1 - 0.08 * d;
      break;
    }
    case "happy": {
      const hf = 6;
      const chat = Math.abs(Math.sin(at * hf));
      brx = -0.85 + 0.1 * chat;
      bpy += 0.24 + 0.08 * chat;
      bry = 0.9 * Math.sin(at * 1.8);
      hrx = 0.3 + 0.14 * chat;
      hrz = 0.2 * Math.sin(at * 3.1);
      tbx = 0.65;
      ttx = 0.35 * Math.sin(at * 11);
      pSweep = 0.5 + 0.3 * Math.sin(at * 10);
      pLift = -0.4 - 0.3 * Math.sin(at * 10);
      pSplit = 0.3 * Math.sin(at * 10 + Math.PI);
      dorsalTilt = 0.18 * Math.sin(at * 6);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.head.rotation.set(hrx, hry, hrz);
  p.dorsal.rotation.set(0, 0, dorsalTilt);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailTip.rotation.set(ttx, tty, 0);
  p.pectR.rotation.set(0, -0.35 + pSweep, -0.3 - pLift + pSplit);
  p.pectL.rotation.set(0, 0.35 - pSweep, 0.3 + pLift + pSplit);
}

export const skills: SkillDef[] = [
  {
    id: "finnick.sonar-ping",
    nameKey: "skill.finnick.sonar-ping.name",
    descriptionKey: "skill.finnick.sonar-ping.desc",
    element: "water",
    targeting: "projectile",
    cost: 4,
    cooldown: 1.2,
    power: 10,
    range: 17,
    learnAtLevel: 1,
    castAnim: "cast",
  },
  {
    id: "finnick.breach",
    nameKey: "skill.finnick.breach.name",
    descriptionKey: "skill.finnick.breach.desc",
    element: "water",
    targeting: "melee",
    cost: 10,
    cooldown: 3.6,
    power: 19,
    range: 3.2,
    learnAtLevel: 4,
    castAnim: "special",
  },
  {
    id: "finnick.wake-spiral",
    nameKey: "skill.finnick.wake-spiral.name",
    descriptionKey: "skill.finnick.wake-spiral.desc",
    element: "water",
    targeting: "aoe",
    cost: 16,
    cooldown: 6.5,
    power: 24,
    range: 4.2,
    storePrice: 250,
    castAnim: "attack",
  },
  {
    id: "finnick.echo-song",
    nameKey: "skill.finnick.echo-song.name",
    descriptionKey: "skill.finnick.echo-song.desc",
    element: "water",
    targeting: "support",
    cost: 17,
    cooldown: 9,
    power: 24,
    range: 8,
    storePrice: 310,
    castAnim: "cast",
  },
];

export const species: BeastSpecies = {
  id: "finnick",
  nameKey: "beast.finnick.name",
  descriptionKey: "beast.finnick.desc",
  element: "water",
  locomotion: "swimming",
  // 21.8 u/s in water, 6.9 on land after LAND_FLOP — that trade is the species.
  baseStats: { maxHp: 48, attack: 12, defense: 6, speed: 6.8 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
