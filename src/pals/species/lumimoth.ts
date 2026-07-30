import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// ---------------------------------------------------------------------------
// Lumimoth — a radiant moth of warm gold and cream, lantern-tipped.
// ---------------------------------------------------------------------------

const S = 0.1; // voxel scale

const C = {
  cream: 0xf9ecd2,
  creamDk: 0xe8d0a6,
  fuzz: 0xfff8e8,
  gold: 0xffc147,
  goldHot: 0xf29a3a,
  goldDeep: 0xdc8a26,
  spot: 0xfffbf0,
  vein: 0xd98f2e,    // wing veins: radiate root-to-tip, the pattern that turns a
  // gold sheet into a membrane. Distinct from `under`, which is a lighting value.
  // Dark plum iris, bright catchlight. The gold iris that was here was only a step
  // off the cream face, so all that survived at portrait distance was the small dark
  // pupil — "two tiny dark squares in a large blank cream face", as a critic put it,
  // and the eye ended up smaller than it started. Making the whole 2x2 the dark mass
  // is what finally gives this face a gaze.
  iris: 0x3a2350,    // deep plum — a moth's dark compound eye
  eyeShine: 0xfffdf6,
  eyeLid: 0xc9a473,  // cream at ~65%: the socket rim. There is no ambient AO in
  // build(), so a recess only reads if it is painted.
  tipGlow: 0xfff1b8, // emissive wingtip lanterns
  leg: 0x6d5136,     // tucked legs, dark enough to be a break in the cream
  glow: 0xffe9a3,      // lantern voxels (emissive in their own right)
  glowEmissive: 0xffd75e,
  edge: 0xffcf6a,    // luminous wing rim (emissive)
  under: 0xc98f34,   // shaded wing underside / thorax contact shadow. Lifted off
  // 0xb5731e, which was so dark and saturated it read as mud on the belly.
} as const;

// Base pose constants shared between buildRig() and animate()
const BODY_Y = 0.32;
/** Hover height PalActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;
const ANT_RX = -0.55; // antennae tilt forward
const ANT_RZ = 0.55;  // antennae splay
const WING_REST = 0.16;
// Sweep pulled well in (0.28 -> 0.12 and 0.72 -> 0.42). Both pairs used to rake
// back hard, and since a pal always faces the camera in a portrait that meant all
// four wings were foreshortened at once: the moth photographed as a starburst of
// gold bars radiating from a cream ball. Wings held closer to spanwise present
// their pattern instead of their edge.
const UP_SWEEP = 0.12;  // upper wings swept slightly back
const LO_SWEEP = 0.42;  // lower wings swept back more

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'lumimoth.glimmer-dart',
    name: 'Glimmer Dart',
    description: 'Flicks a needle of condensed moonlight from a wingtip. Travels fast, stings brighter.',
    element: 'light',
    targeting: 'projectile',
    cost: 6,
    cooldown: 1.6,
    power: 10,
    range: 18,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'lumimoth.prismbeam',
    name: 'Prismbeam',
    description: 'Focuses lantern-light through shimmering wings into a piercing ray of dawn.',
    element: 'light',
    targeting: 'beam',
    cost: 14,
    cooldown: 5.5,
    power: 22,
    range: 15,
    learnAtLevel: 5,
    castAnim: 'cast',
  },
  {
    id: 'lumimoth.dust-waltz',
    name: 'Dust Waltz',
    description: 'A twirling blizzard of luminous wing-dust that dazzles everything nearby.',
    element: 'light',
    targeting: 'aoe',
    cost: 16,
    cooldown: 8,
    power: 20,
    range: 6,
    storePrice: 190,
    castAnim: 'special',
  },
  {
    id: 'lumimoth.lantern-blessing',
    name: 'Lantern Blessing',
    description: 'The abdomen-lantern flares with gentle warmth, mending wounds in its soft halo.',
    element: 'light',
    targeting: 'support',
    cost: 20,
    cooldown: 12,
    power: 28,
    range: 8,
    storePrice: 340,
    castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------

function buildAntenna(): THREE.Mesh {
  const v = new VoxelModel();
  // feathered stalk rising with a forward comb
  v.set(0, 0, 0, C.goldDeep);
  v.set(0, 1, 0, C.goldDeep);
  v.set(0, 2, 0, C.goldDeep);
  v.set(0, 3, 1, C.goldDeep);
  v.set(0, 1, 1, C.gold);   // feather teeth, one per segment
  v.set(0, 3, 2, C.gold);
  const m = v.build(S, false);
  m.position.set(-0.05, 0, -0.05);
  return m;
}

/**
 * dir: +1 right wing (extends +x), -1 left wing.
 *
 * Every column now carries a full shaded second row underneath. A moth wing is
 * physically a membrane, but a one-voxel membrane is literally zero pixels wide
 * edge-on, and since all four wings sweep back from the thorax, a head-on
 * portrait caught every one of them edge-on at once — which is why the moth
 * photographed as a starburst of gold spikes instead of a moth.
 */
function buildUpperWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  // [backExtent, frontExtent] per column outward from the root.
  // Chord tapers toward the tip so it reads as a wing, not a plank.
  // Column 0's chord runs the full depth of the thorax so the wing root is BURIED
  // in the body. At [-2, 2] it started behind the shoulder, leaving a wedge of sky
  // between wing and thorax that read as a detached wing.
  // The trailing edge (z0) now ZIGZAGS -3/-4/-3/-4... That is the scallop: a moth's
  // hindmost edge is notched, and the previous smooth taper is what let a critic
  // read the pair as "two flat featureless tan planks ... slices of bread".
  const cols: Array<[number, number]> = [
    [-3, 3], [-4, 3], [-3, 3], [-4, 2], [-3, 2], [-4, 1], [-2, 1],
  ];
  cols.forEach(([z0, z1], i) => {
    // TWO tonal panels, split at the third column: a deeper gold inboard field and a
    // brighter one outboard, so the wing has an internal value break instead of being
    // one flat sheet from root to tip.
    const panel = i <= 2 ? C.goldDeep : C.gold;
    for (let z = z0; z <= z1; z++) {
      const rim = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, rim ? C.edge : panel);
      if (i < 6) v.set(cell(i), -1, z, C.under); // full shaded underside
    }
  });
  // Veins: continuous darker lines running root-to-tip along the span, plus one down
  // the panel seam. Without them the wing is a single flat value — gold foil.
  cols.forEach(([z0, z1], i) => {
    for (const z of [-1, 1]) {
      if (z > z0 && z < z1) v.set(cell(i), 0, z, C.vein); // never eat the rim
    }
  });
  // Glowing LANTERN TIPS, not a glowing outline. An emissive rim all the way round
  // every column drew a neon border around the wing's silhouette and flattened the
  // pattern inside it; concentrating the light in the outermost two columns is what
  // makes this creature read as a moth carrying a lamp.
  // The OUTERMOST column only, plus the aft half of the one inboard of it. Lighting
  // both whole outer columns turned the tip into a flat white paddle and swallowed the
  // gold taper that makes the wing read as a wing.
  for (let z = cols[6][0]; z <= cols[6][1]; z++) v.set(cell(6), 0, z, C.tipGlow);
  v.set(cell(5), 0, cols[5][0], C.tipGlow);
  // One big white eye-spot near the tip plus a couple of freckles inboard. The
  // old nine scattered spot cells were noise at any distance; a moth's eye-spot
  // is supposed to be a single bold mark.
  v.set(cell(4), 0, 0, C.spot);
  v.set(cell(5), 0, 0, C.spot);
  v.set(cell(4), 0, -1, C.spot);
  v.set(cell(5), 0, -1, C.spot);
  v.set(cell(4), 0, 1, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.set(cell(2), 0, 2, C.spot);
  // Light-element creature, so it actually emits. 0.55 on the tips only and 0.18 on
  // the rim: with a bloom pass in front of it that is a visible halo around the
  // wingtips rather than the clipped white core the emberfox flame used to produce.
  v.markEmissive(C.tipGlow, 0.55);
  v.markEmissive(C.edge, 0.18);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildLowerWing(dir: number): THREE.Mesh {
  const v = new VoxelModel();
  const cell = (i: number): number => (dir > 0 ? i : -i - 1);
  // Scalloped trailing edge here too, and a deliberately shorter, deeper-toned
  // hindwing so the two pairs are distinguishable in silhouette.
  const cols: Array<[number, number]> = [
    [-4, 2], [-3, 1], [-4, 0], [-2, 0], [-3, -1],
  ];
  cols.forEach(([z0, z1], i) => {
    for (let z = z0; z <= z1; z++) {
      const rim = z === z0 || z === z1 || i === cols.length - 1;
      v.set(cell(i), 0, z, rim ? C.edge : i <= 1 ? C.goldDeep : C.goldHot);
      if (i < 4) v.set(cell(i), -1, z, C.under);
    }
  });
  cols.forEach(([z0, z1], i) => {
    if (-1 > z0 && -1 < z1) v.set(cell(i), 0, -1, C.vein);
  });
  v.set(cell(4), 0, cols[4][0], C.tipGlow);
  v.set(cell(4), 0, cols[4][1], C.tipGlow);
  v.set(cell(2), 0, -2, C.spot);
  v.set(cell(1), 0, -2, C.spot);
  v.markEmissive(C.tipGlow, 0.55);
  v.markEmissive(C.edge, 0.18);
  const m = v.build(S, false);
  m.position.y = -0.05;
  return m;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);
  parts.body = body;

  // -- thorax: fuzzy cream heart of the moth --
  const thoraxVox = new VoxelModel();
  // Grown 2.6/2.7/3.4 -> 3.1/3.1/3.8. The moth photographed as a head with a small
  // grey slab under it: the thorax was smaller than the skull AND hidden behind the
  // wing roots, so the whole middle of the animal was missing.
  thoraxVox.ellipsoid(0, 3.2, 0, 3.1, 3.1, 3.8, C.cream);
  thoraxVox.ellipsoid(0, 5.0, 2.2, 3.2, 1.5, 1.4, C.fuzz); // fluffy collar ruff
  thoraxVox.ellipsoid(0, 1.2, 0.4, 2.4, 1.2, 2.8, C.creamDk); // shaded underside
  // Shoulder coverts: a fuzz lump where each wing root enters the body. Without
  // them the wing's leading edge left a wedge of sky between itself and the thorax,
  // which is what made the wings look bolted on rather than grown.
  for (const sx of [1, -1]) {
    for (let z = -1; z <= 2; z++) {
      thoraxVox.set(sx * 2, 5, z, C.fuzz);
      thoraxVox.set(sx * 3, 4, z, C.fuzz);
    }
  }
  // Tucked legs. A hovering moth folds them under the thorax; three dark cells a
  // side is enough to give the underside a break and stop the body ending in a
  // smooth cream curve that dissolves into pale sand.
  for (const sx of [1, -1]) {
    thoraxVox.set(sx * 1, 0, 2, C.leg);
    thoraxVox.set(sx * 2, 0, 1, C.leg);
    thoraxVox.set(sx * 1, 0, -1, C.leg);
  }
  shadeUnder(thoraxVox, C.under, -3, 3, 1, 2, -3, 3); // deep contact shadow, so an
  // all-cream moth still has a bottom edge against a bright sky. Starts at y=1 so
  // it does not repaint the leg cells at y=0.
  const thorax = thoraxVox.build(S);
  // -0.40, not -0.30: build() anchors y=0 at the lowest voxel and the tucked legs
  // now add a row below the barrel, so without this the whole thorax rides up a cell.
  thorax.position.y = -0.40;
  body.add(thorax);

  // -- head with big charming eyes --
  const head = new THREE.Group();
  head.position.set(0, 0.08, 0.30);
  body.add(head);
  parts.head = head;

  const headVox = new VoxelModel();
  // Skull widened 2.3 -> 2.9. The old eyes were single-cell columns buried at
  // z=0-1, i.e. on the SIDES of the head rather than the front, so a moth facing
  // the camera had two dark slivers at its silhouette edge and no face at all.
  headVox.ellipsoid(0, 2.2, 0, 2.9, 2.1, 2.0, C.cream);
  headVox.ellipsoid(0, 1.1, 0.8, 2.0, 1.0, 1.6, C.fuzz); // fuzzy cheeks
  headVox.box(-3, 2, 2, 3, 4, 2, C.cream);                // flat face plate
  rimTop(headVox, C.fuzz, -2, 2, 0, 4, -2, 2);
  shadeUnder(headVox, C.creamDk, -3, 3, 0, 1, -2, 1);
  // Gold iris with a plum pupil. The old pair was a 2x2 block of near-black plum on
  // a cream face — two dark rectangles that read as a visor, not eyes.
  eyes2x2(headVox, {
    inner: 1, y: 2, faceZ: 2, iris: C.iris, shine: C.eyeShine,
    lid: C.eyeLid, browProud: true, bridge: C.fuzz,
  });
  const headMesh = headVox.build(S);
  headMesh.position.y = -0.22;
  head.add(headMesh);

  // -- feathered antennae --
  const antL = new THREE.Group();
  antL.position.set(-0.09, 0.18, 0.06);
  antL.rotation.set(ANT_RX, 0, ANT_RZ);
  antL.add(buildAntenna());
  head.add(antL);
  parts.antL = antL;

  const antR = new THREE.Group();
  antR.position.set(0.09, 0.18, 0.06);
  antR.rotation.set(ANT_RX, 0, -ANT_RZ);
  antR.add(buildAntenna());
  head.add(antR);
  parts.antR = antR;

  // -- banded abdomen swinging from the rear --
  const abdomen = new THREE.Group();
  abdomen.position.set(0, 0.02, -0.24);
  body.add(abdomen);
  parts.abdomen = abdomen;

  const abVox = new VoxelModel();
  abVox.ellipsoid(0, 2.4, -2.6, 2.3, 2.3, 3.4, C.creamDk);
  abVox.ellipsoid(0, 2.4, -1.4, 2.35, 2.35, 0.7, C.gold); // lantern bands
  abVox.ellipsoid(0, 2.4, -3.6, 2.15, 2.15, 0.7, C.gold);
  // The bands GLOW, at a third of the lantern's intensity. A creature called
  // Lumimoth that emitted nothing anywhere on its body was the single most
  // indefensible note in the critique; two dim bands plus a lit tip is the reading
  // "bioluminescent" needs, and it stays well under the level where bloom clips.
  abVox.markEmissive(C.gold, 0.3);
  const abMesh = abVox.build(S);
  abMesh.position.set(0, -0.24, -0.26);
  abdomen.add(abMesh);

  // -- glowing lantern tip: the voxels themselves are flagged emissive, so the
  // lantern still reads as lit in a portrait crop even if the halo sprite is
  // culled or the bloom pass is absent. build() hands the emissive cells back
  // in a child mesh — that child is what animate() pulses. --
  const glowVox = new VoxelModel();
  glowVox.ellipsoid(0, 1.2, 0, 1.3, 1.3, 1.5, C.glow);
  // 0.5, not 0.9, and animate() still multiplies by 1.5 on top: with the bloom
  // pass in place the lantern was a white sphere that ate the abdomen bands.
  glowVox.markEmissive(C.glow, 0.5);
  const glow = glowVox.build(S);
  glow.position.set(0, -0.36, -0.62);
  abdomen.add(glow);
  parts.glow = glow;

  // Fake bloom: warm-gold halo hugging the lantern. Parented to the abdomen
  // (not to the lantern mesh) so it still swings with every animation while
  // glow.children[0] stays the emissive voxel batch. Never frustum-culled.
  const lanternGlow = makeGlowSprite(C.glowEmissive, 0.32, 0.18);
  lanternGlow.position.set(0, -0.21, -0.62);
  lanternGlow.frustumCulled = false;
  abdomen.add(lanternGlow);

  // Slightly larger, very soft halo behind the wings — ambient light-moth
  // aura, deliberately faint so it never becomes a blown-out orb.
  const wingHalo = makeGlowSprite(0xffe08a, 0.5, 0.08);
  wingHalo.position.set(0, 0.1, -0.08);
  wingHalo.frustumCulled = false;
  body.add(wingHalo);

  // -- four wings, upper pair grand, lower pair trailing --
  const wingUR = new THREE.Group();
  wingUR.position.set(0.14, 0.16, -0.04);
  wingUR.rotation.set(0, UP_SWEEP, WING_REST);
  wingUR.add(buildUpperWing(1));
  body.add(wingUR);
  parts.wingUR = wingUR;

  const wingUL = new THREE.Group();
  wingUL.position.set(-0.14, 0.16, -0.04);
  wingUL.rotation.set(0, -UP_SWEEP, -WING_REST);
  wingUL.add(buildUpperWing(-1));
  body.add(wingUL);
  parts.wingUL = wingUL;

  const wingLR = new THREE.Group();
  wingLR.position.set(0.12, 0.06, -0.08);
  wingLR.rotation.set(0, LO_SWEEP, WING_REST * 0.7);
  wingLR.add(buildLowerWing(1));
  body.add(wingLR);
  parts.wingLR = wingLR;

  const wingLL = new THREE.Group();
  wingLL.position.set(-0.12, 0.06, -0.08);
  wingLL.rotation.set(0, -LO_SWEEP, -WING_REST * 0.7);
  wingLL.add(buildLowerWing(-1));
  body.add(wingLL);
  parts.wingLL = wingLL;

  // Ground contact blob — see contactshadow.ts. In the critic's sand portrait the
  // palm beside the moth cast a shadow and the moth cast none, because its real
  // shadow lands well behind it from 1.55 units up under a low sun.
  const blob = makeContactBlob(0.6, HOVER, 0.3);
  root.add(blob);
  parts.blob = blob;

  return { root, parts, height: 0.66, radius: 0.36 };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v: number): number => 1 - (1 - v) ** 3;
const easeInOutSine = (v: number): number => 0.5 - 0.5 * Math.cos(Math.PI * v);

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;

  // Contact blob: flat on the ground, wider while the wings are spread.
  updateContactBlob(p.blob, rig.root, 1 + 0.2 * clamp01(1 - p.wingUR.rotation.z));

  // ---- default hover-idle pose ----
  let bodyX = 0;
  let bodyZ = 0;
  let bodyY = BODY_Y + Math.sin(t * 2.6) * 0.035;
  let bodyRX = Math.sin(t * 1.3) * 0.04;
  let bodyRY = 0;
  let bodyRZ = Math.sin(t * 1.1 + 1.7) * 0.05;
  let sq = 1;
  let flap = Math.sin(t * 9) * 0.45 + 0.18;
  let flapLo = Math.sin(t * 9 - 0.7) * 0.36 + 0.12;
  let wingTilt = Math.sin(t * 1.6) * 0.14; // slow shimmer-tilt catchlight
  let headRX = Math.sin(t * 0.7) * 0.10;
  let headRY = Math.sin(t * 0.43) * 0.16;
  let headRZ = Math.sin(t * 0.9 + 2.0) * 0.06;
  let antSway = Math.sin(t * 2.2) * 0.10;
  let antLift = 0;
  let abdRX = Math.sin(t * 2.0 + 1.0) * 0.09;
  let abdRY = Math.sin(t * 1.4) * 0.06;
  let glowI = 0.85 + Math.sin(t * 3.2) * 0.30;

  switch (ctx.action) {
    case 'fly':
    case 'walk':
    case 'run':
    case 'swim': {
      const k = 0.4 + 0.6 * ctx.moveSpeed;
      const w = t * (16 + 8 * ctx.moveSpeed);
      const s = Math.sin(w);
      // Beat biased below level (-0.18) and amplitude trimmed: a symmetric stroke
      // put the wings vertical at both extremes, and a still frame lands on an
      // extreme most of the time. Off-centre, the camera mostly sees wing.
      flap = -0.18 + s * (0.42 + 0.38 * k);
      flapLo = -0.14 + Math.sin(w - 0.9) * (0.36 + 0.3 * k);
      wingTilt = 0.22 - 0.1 * k + Math.sin(w - 0.5) * 0.08; // upper surface tipped
      // toward a camera that always looks slightly down at the subject
      bodyY = BODY_Y + Math.sin(w - 1.2) * 0.045 * k + Math.sin(t * 2.6) * 0.02;
      bodyRX = 0.22 * k + Math.sin(w - 1.4) * 0.05;
      bodyRZ = Math.sin(t * 1.7) * 0.10 * k; // lazy banking drift
      headRX = -0.18 * k; // keep gaze level against body pitch
      headRY = Math.sin(t * 0.9) * 0.08;
      antLift = 0.5 * k; // antennae streaming back
      abdRX = -0.10 * k + Math.sin(w - 1.8) * 0.10;
      abdRY = Math.sin(t * 1.7) * 0.05;
      glowI = 1.0 + Math.sin(t * 6) * 0.25;
      break;
    }
    case 'attack': {
      const wind = easeOutCubic(clamp01(at / 0.14));
      const lunge = easeOutCubic(clamp01((at - 0.14) / 0.16));
      const settle = easeInOutSine(clamp01((at - 0.30) / 0.30));
      const punch = lunge * (1 - settle);
      const coil = wind * (1 - lunge);
      bodyRX = -0.35 * coil + 0.55 * punch;
      bodyZ = -0.06 * coil + 0.16 * punch;
      bodyY = BODY_Y + 0.05 * coil - 0.03 * punch;
      sq = 1 - 0.06 * coil + 0.06 * punch;
      flap = Math.sin(t * 30) * 0.8;
      flapLo = Math.sin(t * 30 - 0.8) * 0.6;
      wingTilt = -0.4 * punch;
      headRX = -0.2 * coil + 0.28 * punch;
      antLift = 0.45 * punch;
      abdRX = 0.25 * coil - 0.2 * punch;
      glowI = 0.9 + punch * 1.3;
      break;
    }
    case 'cast': {
      const rise = easeOutCubic(clamp01(at / 0.35));
      const quiver = Math.sin(t * 26) * 0.06 * rise;
      bodyRX = -0.45 * rise;
      bodyY = BODY_Y + 0.10 * rise + Math.sin(t * 3) * 0.02;
      flap = 0.9 * rise + quiver;
      flapLo = 0.6 * rise + quiver;
      wingTilt = 0.25 * rise;
      headRX = -0.25 * rise;
      antLift = -0.30 * rise; // perked
      antSway = Math.sin(t * 14) * 0.05;
      abdRX = 0.35 * rise; // lantern curled forward, presented
      glowI = 0.9 + rise * 2.2 + Math.sin(t * 14) * 0.3 * rise;
      break;
    }
    case 'special': {
      const u = clamp01(at / 1.1);
      const arc = Math.sin(u * Math.PI);
      bodyRY = easeInOutSine(u) * Math.PI * 2; // full pirouette
      bodyY = BODY_Y + arc * 0.22;
      sq = 1 + arc * 0.08;
      flap = Math.sin(t * 26) * 1.0;
      flapLo = Math.sin(t * 26 - 0.8) * 0.8;
      wingTilt = 0.3 * arc;
      headRX = -0.2 * arc;
      antLift = -0.35 * arc;
      abdRX = 0.3 * arc;
      abdRY = Math.sin(t * 8) * 0.1;
      glowI = 1 + arc * 2.6;
      break;
    }
    case 'hurt': {
      const d = Math.max(0, 1 - at / 0.45);
      bodyX = Math.sin(at * 55) * 0.045 * d;
      bodyRZ = Math.sin(at * 48) * 0.14 * d;
      bodyRX = -0.25 * d; // recoil rearing back
      bodyY = BODY_Y + 0.04 * d;
      headRX = 0.30 * d; // head ducks
      antLift = 0.6 * d; // antennae blown flat
      flap = Math.sin(t * 34) * 0.9 * d + 0.2;
      flapLo = Math.sin(t * 34 - 0.6) * 0.7 * d + 0.15;
      abdRX = 0.3 * d;
      glowI = 0.35;
      break;
    }
    case 'happy': {
      const hop = Math.abs(Math.sin(at * 7));
      bodyY = BODY_Y + hop * 0.14;
      sq = 1 + Math.sin(at * 14) * 0.06;
      bodyRZ = Math.sin(at * 7) * 0.12;
      bodyRY = Math.sin(at * 3.5) * 0.35;
      flap = Math.sin(t * 20) * 0.7 + 0.2;
      flapLo = Math.sin(t * 20 - 0.7) * 0.55 + 0.15;
      wingTilt = Math.sin(at * 7) * 0.15;
      headRZ = Math.sin(at * 7) * 0.18;
      headRX = -0.12;
      antLift = -0.35; // perked with joy
      antSway = Math.sin(at * 10) * 0.15;
      abdRX = Math.sin(at * 12) * 0.25; // waggle
      glowI = 1.2 + hop * 1.0;
      break;
    }
    case 'idle':
    default:
      break;
  }

  // ---- apply ----
  const body = p.body;
  body.position.set(bodyX, bodyY, bodyZ);
  body.rotation.set(bodyRX, bodyRY, bodyRZ);
  const xz = 1 + (1 - sq) * 0.6;
  body.scale.set(xz, sq, xz);

  p.head.rotation.set(headRX, headRY, headRZ);
  p.antL.rotation.set(ANT_RX + antLift + antSway, 0, ANT_RZ);
  p.antR.rotation.set(ANT_RX + antLift - antSway, 0, -ANT_RZ);
  p.abdomen.rotation.set(abdRX, abdRY, 0);

  p.wingUR.rotation.set(wingTilt, UP_SWEEP, WING_REST + flap);
  p.wingUL.rotation.set(wingTilt, -UP_SWEEP, -(WING_REST + flap));
  p.wingLR.rotation.set(wingTilt * 0.7, LO_SWEEP, WING_REST * 0.7 + flapLo);
  p.wingLL.rotation.set(wingTilt * 0.7, -LO_SWEEP, -(WING_REST * 0.7 + flapLo));

  // The lantern's voxels are emissive, so build() moved them into a child mesh
  // with its own material; pulse that (falling back to the parent's material if
  // the lantern ever stops being fully emissive). No allocation per frame.
  const lantern = (p.glow.children.length > 0 ? p.glow.children[0] : p.glow) as THREE.Mesh;
  const glowMat = lantern.material as THREE.MeshStandardMaterial;
  glowMat.emissiveIntensity = glowI * 0.9; // lantern always outshines the wing rims
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'lumimoth',
  name: 'Lumimoth',
  element: 'light',
  locomotion: 'flying',
  description:
    'A radiant moth that drifts between lantern posts at dusk, its glowing tail-light '
    + 'said to guide lost travelers home. Collects starlight on its wing-spots.',
  baseStats: { maxHp: 34, attack: 9, defense: 6, speed: 5.2 },
  skills: [
    'lumimoth.glimmer-dart',
    'lumimoth.prismbeam',
    'lumimoth.dust-waltz',
    'lumimoth.lantern-blessing',
  ],
  buildRig,
  animate,
};
