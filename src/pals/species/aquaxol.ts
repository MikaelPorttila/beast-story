import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Aquaxol — a perpetually smiling amphibious axolotl with party-streamer gills.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground /
// water level. Swims with lateral body undulation; waddles on its belly ashore.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette
const AQUA = 0x79d4e4;      // soft aqua-blue body
const AQUA_DEEP = 0x4fa9c4; // mottled back spots
const BELLY = 0xd8f4f2;     // pale belly / chin / toes
const GILL = 0xf06ca8;      // pink gill fronds
const GILL_TIP = 0xffa6cb;  // lighter frond tips
const FIN = 0xb5e9f0;       // translucent-looking fin rim
const EYE = 0x27333f;       // glossy dark axolotl eyes
const SHINE = 0xffffff;
const MOUTH = 0x35586b;     // wide friendly smile
const BLUSH = 0xf6a0b8;

// Base pose constants (must match buildRig)
const BODY_Y = 0.24;
const HEAD_Y = 0.1;
const HEAD_Z = 0.32;
// Gill frond fan: base lift (rotZ) and back-sweep (rotY) per frond, front→back
const GZ: readonly number[] = [0.55, 0.38, 0.2];
const GY: readonly number[] = [0.25, 0.5, 0.75];
const GR = ['gillR1', 'gillR2', 'gillR3'] as const;
const GL = ['gillL1', 'gillL2', 'gillL3'] as const;
const LEG_SPLAY = 0.3; // stubby legs angle outward

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, 0, 2.8, 2.2, 3.2, AQUA);
  m.ellipsoid(0, 0.8, 0, 2.5, 1.3, 2.9, BELLY);  // soft belly
  m.box(0, 5, -1, 0, 5, 1, FIN);                  // little dorsal crest
  // mottled spots along the back
  m.set(2, 3, 1, AQUA_DEEP);
  m.set(-2, 3, -1, AQUA_DEEP);
  m.set(1, 4, 0, AQUA_DEEP);
  m.set(-1, 4, 0, AQUA_DEEP);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, 1, 3.4, 2.4, 2.4, AQUA);      // wide friendly head
  m.ellipsoid(0, 0.9, 1.6, 2.8, 1.2, 1.9, BELLY); // chin
  // wide smile with upturned corners
  for (let x = -2; x <= 2; x++) m.set(x, 1, 3, MOUTH);
  m.set(3, 2, 2, MOUTH);
  m.set(-3, 2, 2, MOUTH);
  // blush dots on the cheeks
  for (const sx of [1, -1]) {
    m.set(sx * 3, 2, 0, BLUSH);
    m.set(sx * 3, 2, 1, BLUSH);
    // glossy 2x2 eyes: white sclera with a dark inner-lower pupil, so white
    // shows above and outside each pupil (open, friendly at a distance)
    m.set(sx * 1, 2, 3, EYE);
    m.set(sx * 2, 2, 3, SHINE);
    m.set(sx * 1, 3, 3, SHINE);
    m.set(sx * 2, 3, 3, SHINE);
  }
  return m.build(S, true);
}

/** One feathery gill frond; dir=+1 grows toward +X (right), -1 toward -X. */
function makeFrond(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, GILL);
  m.set(dir * 1, 0, 0, GILL);
  m.set(dir * 2, 0, 0, GILL);
  m.set(dir * 3, 0, 0, GILL_TIP);
  m.set(dir * 1, 0, 1, GILL_TIP);   // forward wisp
  m.set(dir * 2, 0, -1, GILL_TIP);  // trailing wisp
  return m.build(S, false); // keep pivot at the root of the frond
}

function makeLeg(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 1, 1, AQUA);
  m.set(0, 0, 2, BELLY); // tiny toes
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
  m.ellipsoid(0, 2, -1.8, 0.7, 2.6, 2.4, FIN);   // thin fin blade
  m.ellipsoid(0, 2, -1.5, 0.8, 1.7, 1.7, AQUA);  // fleshy core, rim stays pale
  return m.build(S, true);
}

function buildRig(): PalRig {
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
  headMesh.position.set(0, -0.14, 0.1);
  head.add(headMesh);

  // Three pink gill fronds per side, fanned along the back of the head
  const gills: Record<string, THREE.Group> = {};
  const gz = [0.06, -0.04, -0.12];
  const gy = [0.26, 0.24, 0.2];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Group();
    r.position.set(0.28, gy[i], gz[i]);
    r.rotation.set(0, GY[i], GZ[i]);
    head.add(r);
    r.add(makeFrond(1));
    gills[GR[i]] = r;

    const l = new THREE.Group();
    l.position.set(-0.28, gy[i], gz[i]);
    l.rotation.set(0, -GY[i], -GZ[i]);
    head.add(l);
    const lFrond = makeFrond(-1);
    lFrond.position.x = -0.1; // mirror the center=false voxel-grid pivot offset
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
  const legFL = mkLegGroup(0.18, 0.22);
  const legFR = mkLegGroup(-0.18, 0.22);
  const legBL = mkLegGroup(0.18, -0.2);
  const legBR = mkLegGroup(-0.18, -0.2);

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
    height: 0.7,
    radius: 0.45,
  };
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.1);

  // Pose state, written in full every frame.
  let bpx = 0, bpy = BODY_Y + 0.004 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.012 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0, hpy = HEAD_Y, hpz = HEAD_Z;
  let flrx = 0, frrx = 0, blrx = 0, brrx = 0, legSplayMul = 1;
  let tbx = 0, tby = 0, ttx = 0, tty = 0;
  // Gill controls: extra lift (flare), extra back-sweep, ripple wave
  let gillFlare = 0, gillBack = 0, gillWaveAmp = 0.1, gillFreq = 1.8, gillSweepAmp = 0.06, gillPhase = 0;

  switch (ctx.action) {
    case 'idle': {
      bsy = 1 + 0.028 * br;
      bsx = bsz = 1 - 0.012 * br;
      hrx = 0.05 * Math.sin(t * 1.5 + 0.4);
      hry = 0.08 * Math.sin(t * 0.23);
      // contented head tilt pulses
      hrz = 0.04 * Math.sin(t * 0.7) + 0.22 * Math.max(0, Math.sin(t * 0.31 + 2.1)) ** 12;
      gillWaveAmp = 0.14;
      gillFlare = 0.25 * Math.max(0, Math.sin(t * 0.5 + 2)) ** 10; // occasional proud flare
      tby = 0.15 * Math.sin(t * 1.3);
      tty = 0.2 * Math.sin(t * 1.3 - 0.9);
      // sleepy toe wiggles
      flrx = 0.08 * Math.sin(t * 1.9);
      brrx = 0.08 * Math.sin(t * 1.9 + 2);
      break;
    }
    case 'walk':
    case 'run': { // the famous belly waddle
      const isRun = ctx.action === 'run';
      const f = (isRun ? 8 : 5.5) + 3 * ms;
      const ph = t * f;
      const amp = (isRun ? 0.9 : 0.65) * (0.5 + 0.5 * ms);
      brz = (isRun ? 0.17 : 0.13) * Math.sin(ph);       // roll waddle
      bry = 0.09 * Math.sin(ph - 0.4);                  // butt wiggle
      bpy += 0.02 * Math.sin(ph * 2) + (isRun ? 0.035 * Math.max(0, Math.sin(ph * 2 + 0.5)) : 0);
      bsy = 1 + 0.04 * Math.sin(ph * 2 + 0.8);
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      flrx = brrx = amp * Math.sin(ph);
      frrx = blrx = amp * Math.sin(ph + Math.PI);
      hrz = -0.1 * Math.sin(ph);                        // head counter-roll
      hrx = 0.05 * Math.sin(ph * 2) - 0.04 * ms;
      // tail drags side to side; gills flop with a springy lag
      tby = 0.4 * Math.sin(ph - 1.0);
      tty = 0.55 * Math.sin(ph - 1.7);
      gillWaveAmp = 0.24;
      gillFreq = f;
      gillPhase = -1.2;
      gillSweepAmp = 0.1;
      break;
    }
    case 'swim':
    case 'fly': { // graceful lateral undulation (fly never happens; swim it)
      const f = 4.5 + 3.5 * ms;
      const ph = t * f;
      bry = 0.1 * Math.sin(ph);
      brz = 0.07 * Math.sin(ph - 0.6);                  // gentle banking roll
      brx = 0.03 + 0.04 * Math.sin(t * 1.5);
      bpy += 0.03 * Math.sin(t * 2.1);
      tby = 0.5 * Math.sin(ph - 0.9);
      tty = 0.7 * Math.sin(ph - 1.7);
      // legs sweep back and flutter
      legSplayMul = 0.3;
      flrx = 1.0 + 0.15 * Math.sin(ph * 2);
      frrx = 1.0 + 0.15 * Math.sin(ph * 2 + 1.2);
      blrx = 1.0 + 0.15 * Math.sin(ph * 2 + 2.4);
      brrx = 1.0 + 0.15 * Math.sin(ph * 2 + 3.6);
      hrx = 0.05 * Math.sin(ph - 0.4);
      hry = 0.08 * Math.sin(ph + 0.5);
      // gills stream back and ripple in the flow
      gillBack = 0.45;
      gillWaveAmp = 0.26;
      gillFreq = f;
      gillSweepAmp = 0.16;
      break;
    }
    case 'attack': { // wind up, then a surprisingly quick chomp-lunge
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
      gillFlare = 0.6 * kp;                             // gills snap wide on the bite
      gillBack = 0.3 * wind * (1 - lunge);
      flrx = frrx = -0.5 * kp + 0.4 * wind * (1 - lunge);
      blrx = brrx = 0.5 * kp;
      tby = -0.35 * k;                                  // tail counter-whip
      tty = -0.45 * k;
      break;
    }
    case 'cast': { // rears up, gills fanned wide and shimmering with power
      const rise = ezOut(clamp01(at / 0.4));
      const tremor = 0.5 * Math.sin(t * 12) + 0.5 * Math.sin(t * 17);
      brx = -0.45 * rise + 0.02 * tremor * rise;
      bpy += 0.08 * rise;
      hrx = 0.28 * rise;
      flrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5) * rise;
      frrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5 + Math.PI) * rise;
      blrx = brrx = 0.4 * rise;
      tbx = -0.3 * rise;                                // tail braces on the ground
      tby = 0.06 * Math.sin(t * 8);
      gillFlare = 0.7 * rise;
      gillWaveAmp = 0.1 + 0.3 * rise;
      gillFreq = 9;
      break;
    }
    case 'special': { // a joyful barrel roll with full gill flare
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
      gillFlare = -0.45 * d;                            // gills clamp tight
      gillBack = 0.5 * d;
      flrx = frrx = 0.25 * d;
      blrx = brrx = -0.25 * d;
      tbx = 0.3 * d;                                    // tail curls down
      bsy = 1 - 0.08 * d;
      bsx = bsz = 1 + 0.04 * d;
      break;
    }
    case 'happy': { // delighted little hops, gills fluttering like streamers
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

  // Gill fronds: mirrored fan, each with its own ripple phase.
  for (let i = 0; i < 3; i++) {
    const lift = GZ[i] + gillFlare + gillWaveAmp * Math.sin(t * gillFreq + gillPhase + i * 0.9);
    const sweep = GY[i] + gillBack + gillSweepAmp * Math.sin(t * gillFreq * 0.8 + i * 0.7);
    p[GR[i]].rotation.set(0, sweep, lift);
    p[GL[i]].rotation.set(0, -sweep, -lift);
  }
}

export const skills: SkillDef[] = [
  {
    id: 'aquaxol.bubble-pop',
    name: 'Bubble Pop',
    description: 'Blows a wobbling bubble that bursts with a surprisingly rude POP.',
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
    name: 'Tide Swirl',
    description: 'Spins its paddle tail to whip up a chilly whirlpool around itself.',
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
    name: 'Soothing Slime',
    description: 'Sheds a film of regenerative slime that patches up nearby friends. Slightly gross, extremely effective.',
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
    name: 'Hydro Jet',
    description: 'Gulps, aims, and fires a pressure-washer stream of water. Do not stand in front of the smile.',
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

export const species: PalSpecies = {
  id: 'aquaxol',
  name: 'Aquaxol',
  element: 'water',
  locomotion: 'amphibious',
  description:
    'A perpetually smiling axolotl that waddles on land and ripples through water, gills fluttering like party streamers.',
  baseStats: { maxHp: 54, attack: 9, defense: 8, speed: 3.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
