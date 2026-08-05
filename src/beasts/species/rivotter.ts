import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Rivotter — a river otter: a long sleek tube of muscle that lopes on land and
// becomes a torpedo the moment it hits water. The AMPHIBIOUS one you pick when
// you do not want to give anything up: it gallops (badly) and swims (superbly),
// where Finnick only swims and Coralback only plods.
//
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground /
// water level. Gallops with a bounding spine flex on land; on water the same
// spine flex becomes the whole stroke and the legs tuck.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette. A wet brown animal is the hardest thing to keep legible in this
// world's lighting — the ground is brown, the tree boles are brown, and a
// mid-brown coat in shade merges with both. So the coat is pushed COOL (there
// is more blue in it than a real otter has) and the belly and muzzle carry
// nearly all the value range: the cream underside is what reads at forty units,
// and it is why the animal is drawn with its chin up.
const COAT = 0x6b5344;      // damp cool brown
const COAT_LIT = 0x94745d;  // sunlit crest along the spine
const COAT_DARK = 0x44342c; // shaded underside and mask
const BELLY = 0xd9c3a1;     // cream throat, chest and muzzle
const BELLY_LIT = 0xf0dcbc;
const PAW = 0x3b2e27;       // webbed feet, near-black
const IRIS = 0x241a15;      // very dark warm brown — never black, see eyes2x2
const SHINE = 0xfff6e6;
const NOSE = 0x2b2119;
const WHISKER = 0xe8ddcb;

// Base pose constants (must match buildRig)
const BODY_Y = 0.30;
const NECK_Z = 0.34;
const HEAD_Y = 0.10;
const LEG_SPLAY = 0.16;
/** Rest sweep of the four legs, front pair and back pair. */
const FORE_REST = -0.10;
const HIND_REST = 0.12;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * Integrated cycle slots — see BeastAnimCtx.cycle(). ONE gait slot for both the
 * bound and the swim stroke, deliberately: they are the same spine, and giving
 * the swim its own slot made an otter running into a lake change pose mid-air.
 */
const GAIT = 0;
/** The tail, which trails the spine at its own rate and lags it. */
const TAIL = 1;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  // A TUBE, not a barrel: 2.4 wide against 7.5 long. Every other quadruped in
  // this roster is roughly as deep as it is long, and the otter's whole read is
  // that it is not — the silhouette has to say "this thing is built to go
  // through water" before any of the colour does.
  m.ellipsoid(0, 2.4, 0, 2.4, 2.3, 4.6, COAT);
  m.ellipsoid(0, 1.3, 0.6, 2.0, 1.3, 3.9, BELLY);   // long pale underside
  shadeUnder(m, COAT_DARK, -3, 3, 0, 2, -6, 6);
  rimTop(m, COAT_LIT, -3, 3, 2, 6, -6, 6);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // Five cells across. The skull is small on purpose — an otter's head is
  // barely wider than its neck, and it is the one place a stubby-headed
  // silhouette is correct rather than a modelling shortcut.
  m.ellipsoid(0, 2, 0.6, 2.4, 2.0, 2.4, COAT);
  m.box(-2, 1, 3, 2, 4, 3, COAT);                    // flat face plate
  // Muzzle: a pale wedge standing one cell proud, with the nose on top of it.
  // Proud rather than flush because this face has no other relief at all — the
  // ears are tiny and the eyes are dark on dark, so without a lit muzzle edge
  // the whole front of the animal photographs as one brown card.
  for (let x = -1; x <= 1; x++) {
    m.set(x, 1, 4, BELLY_LIT);
    m.set(x, 0, 4, BELLY);
    m.set(x, 0, 3, BELLY);
    m.set(x, 1, 3, BELLY);
  }
  m.set(0, 2, 4, NOSE);
  m.set(-1, 2, 4, NOSE);
  m.set(1, 2, 4, NOSE);
  // Whiskers: one cell out either side of the muzzle. Two cells of near-white
  // on a dark head is worth more than it sounds — they are the only thing on
  // this animal that is not a rounded mass, so they read as "face" instantly.
  m.set(-2, 1, 4, WHISKER);
  m.set(2, 1, 4, WHISKER);
  rimTop(m, COAT_LIT, -2, 2, 0, 5, -2, 4);
  eyes2x2(m, {
    inner: 1, width: 1, y: 3, faceZ: 3, iris: IRIS, shine: SHINE,
    lid: COAT_DARK, bridge: COAT_LIT, browProud: true,
  });
  // Ears LAST, so nothing above repaints them: two cells on the crown, which is
  // all an otter has.
  m.set(-2, 5, 0, COAT_DARK);
  m.set(2, 5, 0, COAT_DARK);
  return m.build(S, true);
}

/** One leg: a short upper mass with a webbed paw under it. */
function makeLeg(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 1, 0, 1, 3, 1, COAT);
  m.box(0, 0, 0, 1, 0, 2, PAW);   // webbed foot, reaching forward
  return m.build(S, false);
}

/**
 * Tail root — thick where it leaves the hips.
 *
 * TWO CELLS WIDE, not one, and that is a z-fighting fix rather than a drawing
 * choice: the torso tapers to a single-cell column at its own back end, so a
 * 1-wide tail root put two side faces on exactly the same plane as the hips it
 * hangs off (0.147 in the rest pose, measured by test-zfight). Parting the grid
 * at the joint means the two masses cannot agree on an x, which is the rule in
 * AGENTS.md stated as an arithmetic constraint.
 */
function makeTailBase(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.4, -1.6, 2.2, 1.5, 2.4, COAT);
  shadeUnder(m, COAT_DARK, -2, 2, 0, 2, -4, 2);
  return m.build(S, true);
}

/** Tail tip — tapered to a rudder. */
function makeTailTip(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.2, -2.0, 1.2, 1.0, 2.6, COAT);
  rimTop(m, COAT_LIT, -2, 2, 0, 3, -5, 1);
  return m.build(S, true);
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  // The spine is JOINTED at the waist, which is the one structural decision in
  // this rig: a bounding otter is a wave travelling down its own back, and a
  // single rigid torso can only fake that by bobbing. `chest` carries the front
  // legs and the neck, `body` carries the hips and the tail, and the flex
  // between them is the gait.
  const chest = new THREE.Group();
  chest.position.set(0, 0.02, 0.26);
  body.add(chest);

  const torso = makeTorso();
  torso.position.set(0, -0.16, -0.16);
  body.add(torso);

  const neck = new THREE.Group();
  neck.position.set(0, 0.10, NECK_Z);
  chest.add(neck);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, 0.10);
  neck.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.12, 0);
  head.add(headMesh);

  const mkLeg = (x: number, z: number, parent: THREE.Group, rest: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.10, z);
    g.rotation.set(rest, 0, x > 0 ? LEG_SPLAY : -LEG_SPLAY);
    parent.add(g);
    const mesh = makeLeg();
    mesh.position.set(x > 0 ? -0.05 : -0.05, -0.30, -0.05);
    g.add(mesh);
    return g;
  };
  const legFL = mkLeg(0.20, 0.12, chest, FORE_REST);
  const legFR = mkLeg(-0.20, 0.12, chest, FORE_REST);
  const legBL = mkLeg(0.20, -0.30, body, HIND_REST);
  const legBR = mkLeg(-0.20, -0.30, body, HIND_REST);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, 0.04, -0.62);
  body.add(tailBase);
  const tb = makeTailBase();
  tb.position.set(0, -0.14, -0.14);
  tailBase.add(tb);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0, -0.34);
  tailBase.add(tailTip);
  const tt = makeTailTip();
  tt.position.set(0, -0.12, -0.20);
  tailTip.add(tt);

  return {
    root,
    parts: { body, chest, neck, head, legFL, legFR, legBL, legBR, tailBase, tailTip },
    height: 0.82,
    radius: 0.42,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.3);

  let bpx = 0, bpy = BODY_Y + 0.005 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsy = 1 + 0.012 * br;
  let crx = 0, cry = 0, crz = 0;        // chest, the front half of the spine
  let nrx = 0, nry = 0;                 // neck
  let hrx = 0, hry = 0, hrz = 0;
  let flrx = FORE_REST, frrx = FORE_REST, blrx = HIND_REST, brrx = HIND_REST;
  let splayMul = 1;
  let tbx = 0, tby = 0, ttx = 0, tty = 0;

  switch (ctx.action) {
    case 'idle': {
      // Sitting up on the haunches to look around, which is the pose everyone
      // who has seen an otter remembers. Not held — it pulses, so the animal is
      // usually on all fours and occasionally periscopes.
      // PHASE -1.9, NOT +1.4, and it is worth a line. `sin(1.4)` is 0.985 and
      // the pulse is that to the eighth, so at a session clock of zero the
      // periscope was already 89% up — while `buildRig` had just written the
      // legs at FORE_REST. tools/test-beastanim.mjs saw the difference as a
      // 0.490 rad step between the first two frames of the beast's life, the
      // second-worst in the whole roster, and on screen it is an otter that
      // snaps upright the instant it is spawned or reset. `sin(-1.9)` is
      // negative, so the pulse starts at exactly the rest pose and rises from
      // it about ten seconds later.
      const rise = 0.55 * Math.max(0, Math.sin(t * 0.27 - 1.9)) ** 8;
      bsy = 1 + 0.03 * br;
      crx = -0.5 * rise;
      bpy += 0.05 * rise;
      nrx = -0.25 * rise + 0.05 * Math.sin(t * 1.4);
      hry = 0.22 * Math.sin(t * 0.31);
      hrz = 0.05 * Math.sin(t * 0.8);
      flrx = FORE_REST - 1.0 * rise + 0.06 * Math.sin(t * 2.1);
      frrx = FORE_REST - 1.0 * rise + 0.06 * Math.sin(t * 2.1 + 1.1);
      tbx = -0.25 * rise;
      tby = 0.12 * Math.sin(t * 1.1);
      tty = 0.18 * Math.sin(t * 1.1 - 0.7);
      break;
    }
    case 'walk':
    case 'run': {
      // A BOUND, not a trot: both front legs together, both back legs together,
      // and the spine folding and extending between them. That is how mustelids
      // actually move at speed, and it is also the only gait a two-segment
      // spine can express honestly.
      const isRun = ctx.action === 'run';
      const f = (isRun ? 7.5 : 5.0) + 3.2 * ms;
      const ph = ctx.cycle(GAIT, f);
      const amp = (isRun ? 1.05 : 0.7) * (0.45 + 0.55 * ms);
      const fold = Math.sin(ph);
      crx = (isRun ? 0.34 : 0.2) * fold;                 // spine flex
      bpy += 0.055 * Math.max(0, fold) * (isRun ? 1 : 0.5);
      bsy = 1 + 0.035 * Math.sin(ph * 2 + 0.6);
      flrx = frrx = FORE_REST + amp * Math.sin(ph + 0.5);
      blrx = brrx = HIND_REST + amp * Math.sin(ph + Math.PI + 0.5);
      // Front pair split by a hair so the pose is not a perfect mirror — a
      // bound with two exactly parallel legs reads as a toy.
      frrx += 0.12 * Math.sin(ph + 0.9);
      brrx += 0.12 * Math.sin(ph + Math.PI + 0.9);
      nrx = -0.12 - 0.10 * fold;
      hrx = 0.08 * Math.sin(ph * 2);
      const tw = ctx.cycle(TAIL, f);
      tbx = 0.18 * Math.sin(tw - 0.8);
      tby = 0.14 * Math.sin(tw * 0.5);
      ttx = 0.26 * Math.sin(tw - 1.5);
      break;
    }
    case 'swim':
    case 'fly': {
      // The same spine, doing the only thing it was ever really for. Legs tuck
      // back along the body and steer; the tail is the rudder and does most of
      // the visible work. 'fly' never happens for an amphibian — it swims.
      const f = 5.0 + 4.5 * ms;
      const ph = ctx.cycle(GAIT, f);
      const wave = Math.sin(ph);
      brx = 0.06 + 0.16 * wave;                          // whole body porpoises
      crx = 0.22 * Math.sin(ph - 0.7);
      bpy += 0.035 * Math.sin(ph - 0.4);
      bry = 0.05 * Math.sin(ph * 0.5);
      brz = 0.09 * Math.sin(ph * 0.5 - 0.6);              // lazy bank
      splayMul = 0.35;
      flrx = FORE_REST + 1.05 + 0.10 * Math.sin(ph);      // forepaws folded back
      frrx = FORE_REST + 1.05 + 0.10 * Math.sin(ph + 1.2);
      blrx = HIND_REST + 0.75 + 0.22 * Math.sin(ph + 0.6);
      brrx = HIND_REST + 0.75 + 0.22 * Math.sin(ph + 1.8);
      nrx = -0.18;
      hrx = -0.06 + 0.05 * Math.sin(ph);
      const tw = ctx.cycle(TAIL, f);
      tbx = 0.34 * Math.sin(tw - 1.0);
      tby = 0.16 * Math.sin(tw * 0.5 - 0.4);
      ttx = 0.46 * Math.sin(tw - 1.8);
      tty = 0.20 * Math.sin(tw * 0.5 - 1.1);
      break;
    }
    case 'attack': {
      // Coil and strike — the head goes first and the body follows it, which is
      // what a long animal biting looks like.
      const wind = smooth(phase(at, 0, 0.13));
      const strike = ezOut(phase(at, 0.13, 0.28));
      const rec = smooth(phase(at, 0.42, 0.78));
      const k = -0.55 * wind * (1 - strike) + strike * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.22 * k;
      crx = -0.30 * k;
      nrx = 0.34 * k;
      hrx = 0.22 * k;
      bpy += 0.03 * kp;
      flrx = FORE_REST - 0.55 * kp + 0.45 * wind * (1 - strike);
      frrx = flrx;
      blrx = brrx = HIND_REST + 0.5 * kp;
      tbx = -0.35 * k;
      ttx = -0.5 * k;
      break;
    }
    case 'cast': {
      // Up on the haunches with the forepaws working — an otter opening a
      // shell, borrowed as a spellcasting pose because it is the one thing this
      // animal does with its hands.
      const rise = ezOut(clamp01(at / 0.35));
      const work = Math.sin(t * 13) * 0.5 + Math.sin(t * 19) * 0.5;
      crx = -0.85 * rise;
      bpy += 0.12 * rise;
      nrx = -0.30 * rise;
      hrx = 0.30 * rise + 0.03 * work * rise;
      flrx = FORE_REST - 1.5 * rise + 0.22 * Math.sin(t * 9) * rise;
      frrx = FORE_REST - 1.5 * rise + 0.22 * Math.sin(t * 9 + Math.PI) * rise;
      blrx = brrx = HIND_REST + 0.35 * rise;
      tbx = -0.55 * rise;                                 // tail braces behind
      ttx = -0.30 * rise;
      tty = 0.10 * Math.sin(t * 7);
      break;
    }
    case 'special': {
      // The otter roll: a full barrel roll along the long axis, which is the
      // one trick this shape is built for and reads from any bearing.
      const T = 0.75;
      const k2 = clamp01(at / T);
      const spin = Math.sin(Math.PI * k2);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.24))
        * (1 - smooth(phase(at, T + 0.24, T + 0.6)));
      brz = Math.PI * 2 * smooth(k2);
      bpy += 0.26 * spin;
      bsy = 1 - 0.18 * land;
      crx = 0.35 * spin;
      nrx = -0.2 * spin;
      flrx = frrx = FORE_REST - 0.8 * spin + 0.3 * land;
      blrx = brrx = HIND_REST + 0.9 * spin - 0.3 * land;
      tbx = 0.45 * spin;
      ttx = 0.7 * Math.sin(at * 15) * spin;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.6 * at);
      bpx = 0.04 * Math.sin(at * 40) * d;
      bpz = -0.09 * d;
      bpy -= 0.05 * d;
      crx = 0.32 * d;                                     // hunches
      nrx = 0.26 * d;
      hrx = -0.22 * d;
      brz = 0.08 * Math.sin(at * 33 + 1) * d;
      flrx = FORE_REST + 0.3 * d;
      frrx = FORE_REST + 0.3 * d;
      blrx = brrx = HIND_REST - 0.25 * d;
      tbx = 0.5 * d;                                      // tail tucks under
      ttx = 0.4 * d;
      bsy = 1 - 0.07 * d;
      break;
    }
    case 'happy': {
      // Little bounces on the spot with the tail whipping — same bound, no
      // ground covered.
      const hf = 5.5;
      const hop = Math.abs(Math.sin(at * hf));
      bpy += 0.13 * hop;
      bsy = 0.9 + 0.22 * hop;
      crx = -0.3 * hop;
      bry = 0.26 * Math.sin(at * 2.2);
      nrx = -0.24;
      hrz = 0.22 * Math.sin(at * 2.2 + 1);
      flrx = frrx = FORE_REST - 0.8 * hop;
      blrx = brrx = HIND_REST + 0.5 * hop;
      tbx = 0.3 * Math.sin(at * 12);
      tby = 0.4 * Math.sin(at * 9);
      ttx = 0.45 * Math.sin(at * 12 - 0.8);
      tty = 0.5 * Math.sin(at * 9 - 0.7);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(1, bsy, 1);
  p.chest.rotation.set(crx, cry, crz);
  p.neck.rotation.set(nrx, nry, 0);
  p.head.rotation.set(hrx, hry, hrz);
  p.legFL.rotation.set(flrx, 0, LEG_SPLAY * splayMul);
  p.legFR.rotation.set(frrx, 0, -LEG_SPLAY * splayMul);
  p.legBL.rotation.set(blrx, 0, LEG_SPLAY * splayMul);
  p.legBR.rotation.set(brrx, 0, -LEG_SPLAY * splayMul);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailTip.rotation.set(ttx, tty, 0);
}

export const skills: SkillDef[] = [
  {
    id: 'rivotter.river-dart',
    nameKey: 'skill.rivotter.river-dart.name',
    descriptionKey: 'skill.rivotter.river-dart.desc',
    element: 'water',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.4,
    power: 11,
    range: 15,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'rivotter.otter-roll',
    nameKey: 'skill.rivotter.otter-roll.name',
    descriptionKey: 'skill.rivotter.otter-roll.desc',
    element: 'water',
    targeting: 'aoe',
    cost: 11,
    cooldown: 4.5,
    power: 16,
    range: 4.0,
    learnAtLevel: 4,
    castAnim: 'special',
  },
  {
    id: 'rivotter.slick-coat',
    nameKey: 'skill.rivotter.slick-coat.name',
    descriptionKey: 'skill.rivotter.slick-coat.desc',
    element: 'water',
    targeting: 'support',
    cost: 15,
    cooldown: 8,
    power: 20,
    range: 6,
    storePrice: 210,
    castAnim: 'cast',
  },
  {
    id: 'rivotter.torrent-slide',
    nameKey: 'skill.rivotter.torrent-slide.name',
    descriptionKey: 'skill.rivotter.torrent-slide.desc',
    element: 'water',
    targeting: 'beam',
    cost: 19,
    cooldown: 8.5,
    power: 30,
    range: 13,
    storePrice: 300,
    castAnim: 'cast',
  },
];

export const species: BeastSpecies = {
  id: 'rivotter',
  nameKey: 'beast.rivotter.name',
  descriptionKey: 'beast.rivotter.desc',
  element: 'water',
  locomotion: 'amphibious',
  // Speed 5.2 puts it at 9.6 u/s galloping (a sprint you can hold) and 16.6
  // swimming — the middle of the water roster on both counts, which is what
  // being good at everything costs. See SWIM_GALLOP in player/mount.ts.
  baseStats: { maxHp: 52, attack: 11, defense: 8, speed: 5.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
