import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Umbrakit — a hovering shadow cat woven from dusk. It never walks: it floats
// ~0.3 above the ground on a pool of underglow, glides with a ghostly drift,
// and its wispy tail dissolves into three detached voxels that orbit behind.
// Voxel scale 0.085. Model faces +Z. Root origin at ground level.
// ---------------------------------------------------------------------------

const S = 0.085;

// Palette — dusky violet (NOT near-black: the silhouette must read as a
// shadow creature with visible cat anatomy, never a hole in the frame)
// Lifted well clear of black: under ACES tone mapping the old 0x3a2f4d /
// 0x2a2140 pair crushed into one unreadable void, so the cat silhouette was
// invisible against its own cast shadow.
// Re-floored again for the 4.9:1 sun/fill lighting ratio (sun 2.55, hemi 0.52):
// with that little fill, everything below ~0x60 collapses to black, so the body
// tone and the rim row both had to come up and a pale chest patch was added to
// separate the cat from its own shadow.
const INK = 0x8a76ba;      // body
const DUSK = 0x584b80;     // shadowed underside / muzzle / haunches
const VIOLET = 0x9c7fe0;   // sheen highlights, ear tips
const RIM = 0xc2aef0;      // top rim rows — the silhouette's bright edge
const PALE = 0xc4b6e6;     // chest / belly patch (the form-separating light) —
// pulled down from 0xd8cef0, which under bloom lit up like a bib
const GLOW = 0x8f6fd8;     // underglow / dissolving tail
const LAV = 0xd6c4ff;      // brightest wisp / sparks / eye catchlight
// Eyes. Two rounds were spent trying to make a BRIGHT iris work here — pale gold,
// then near-white gold — and both failed the same way: a 2x3 near-white block per
// side on a mid-violet face is a lit panel, and a critic reading the portrait
// described "two glowing pale bars". The polarity is inverted now. The iris is a very
// dark violet (the coat hue at a fifth of its value) and the light lives in a single
// lavender catchlight cell, which is the ONLY emissive cell on the head — a gleam in
// a dark eye is exactly the right note for a creature woven from dusk.
const IRIS = 0x2a1c40;     // dark violet iris
const NOSE = 0xc79ae8;

// Base pose constants (world/local units, must match buildRig)
const BODY_Y = 0.42;       // hover: body underside sits ~0.3 above origin
const HEAD_Y = 0.07;
const HEAD_Z = 0.2;
const EAR_Z = 0.22;
const PAW_X = -0.7;        // paws tucked, dangling
const TAIL_BASE_X = 0.55;  // tail curls up
const TAIL_MID_X = 0.3;
const TAIL_TIP_X = 0.25;
const GLOW_Y = -0.19;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * Integrated cycle slots — see BeastAnimCtx.cycle(). Every rate below is either
 * scaled by the gait blend or different per action, and all four were being
 * multiplied into the session clock. The wisps were the most obvious: `wSpeed`
 * steps between 1.2 and 7 rad/s across the action list, so at a minute-old
 * clock a single action change flung them several full orbits in one frame.
 */
const DRIFT = 0;  // serpentine body glide
const TAIL = 1;   // the S-wave down the tail, 1.1x the drift while moving
const SURGE = 2;  // the vertical bob, a hair faster than the drift
const WISP = 3;   // detached tail wisps, trailing or orbiting

function makeTorso(): THREE.Mesh {
  // Deliberately few masses: one clean cat body, a narrow spine sheen and the
  // underglow band. The old chest ruff / haunch / glint blobs read as a grape
  // cluster in close-up and buried the silhouette.
  const m = new VoxelModel();
  m.ellipsoid(0, 1.5, -0.2, 2.2, 1.6, 3.0, INK);
  m.ellipsoid(0, 2.5, -0.6, 1.1, 0.6, 2.0, VIOLET);  // moonlit sheen along the spine
  // Crisp rim-light row along the very top of the back: without it the dark
  // body merges into its own cast shadow and loses its silhouette entirely.
  m.ellipsoid(0, 2.95, -0.5, 1.2, 0.3, 2.2, RIM);
  m.ellipsoid(0, 0.3, 0.2, 1.7, 0.7, 2.5, GLOW);     // soft purple underglow band
  // Pale chest/belly patch: under a strong sun with almost no fill the dark coat
  // and its own cast shadow merge, so the front carries a light mass to read the
  // volume against. Painted after the glow band so it wins on the chest.
  m.ellipsoid(0, 1.3, 1.5, 1.8, 1.35, 1.5, PALE);
  rimTop(m, RIM, -2, 2, 1, 4, -3, 3);
  m.markEmissive(GLOW, 0.35);  // soft violet underglow — mysterious, not neon,
  // and trimmed from 0.55 now that a bloom pass amplifies it
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // Skull widened 2.0 -> 2.7 and given a proper face plate: the old head was too
  // narrow to carry an eye pair, so the brow sheen, the pale sclera and the two
  // pupils stacked into one pale band with two dark notches — the bandit mask
  // that every portrait of this cat came back with.
  m.ellipsoid(0, 1.3, 0.2, 2.7, 1.5, 1.7, INK);
  m.ellipsoid(0, 2.3, -0.2, 1.2, 0.5, 1.0, VIOLET);  // narrow brow sheen
  m.ellipsoid(0, 0.5, 1.4, 1.3, 0.8, 0.9, DUSK);     // muzzle
  m.box(-3, 1, 2, 3, 3, 2, INK);                     // flat face plate
  rimTop(m, RIM, -2, 2, 0, 4, -2, 2);
  shadeUnder(m, DUSK, -3, 3, 0, 1, -2, 3);
  // A stepped SNOUT, not a lone proud voxel. The old build set exactly one cell at
  // (0, 1, 3): a 1x1x1 cube standing off a flat plate touches the face with one hidden
  // rear facet and nothing else, so it photographed as "a nose voxel floating in front
  // of the face" — which, visually, it was. Three cells wide with a dark tip in front
  // of them reads as a muzzle.
  for (let x = -1; x <= 1; x++) m.set(x, 1, 3, DUSK);
  m.set(0, 1, 4, NOSE);
  // NOTHING on the head glows. The previous build made the catchlight emissive at
  // 0.45, which is the one thing eyes2x2 explicitly forbids ("a glowing catchlight
  // blooms into a star and eats the iris around it") — and it did exactly that. In a
  // lab close-up at dist 1.7 the cat's face was two pale near-white blocks with a
  // pink dot between them and no visible iris at all: the bloom halo off each 8.5 cm
  // catchlight cell covered the dark cells beside it, so the face went straight back
  // to the "two glowing pale bars" read that inverting the polarity was supposed to
  // cure. LAV is 0.80 luminance against an 0.13 iris as plain paint; that is already
  // the brightest contrast on the model and it needs no help from the bloom pass.
  eyes2x2(m, {
    inner: 1, y: 1, faceZ: 2, iris: IRIS, shine: LAV,
    lid: DUSK, bridge: RIM,
  });
  return m.build(S, true);
}

/**
 * One ear, authored once and mirrored by `sign`. The old signature took a tipX and
 * an innerX per side — hand-mirroring a bilateral feature, which is precisely how
 * ears end up different colours on the two sides of a head.
 */
function makeEar(sign: number): THREE.Mesh {
  const m = new VoxelModel();
  const X = (d: number): number => (sign > 0 ? d : -d - 1); // d: 0 inner, 1 outer
  for (const d of [0, 1]) {
    m.set(X(d), 0, 0, INK);
    m.set(X(d), 1, 0, INK);
  }
  m.set(X(1), 1, 0, RIM);          // lit outer edge
  m.set(X(1), 2, 0, VIOLET);       // pointed tip
  m.set(X(0), 2, 0, VIOLET);       // two-cell tip band, so both ears read from any side
  m.setEmissive(X(0), 0, 1, GLOW, 0.35); // inner-ear glow facing forward
  return m.build(S, true);
}

function makePaw(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 0, 1, DUSK);   // shadowed toes
  m.box(0, 1, 0, 1, 1, 1, INK);
  return m.build(S, true);
}

function makeTailSeg1(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 0.8, -1.0, 1.0, 1.0, 1.5, INK);
  return m.build(S, true);
}

function makeTailSeg2(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 0.7, -0.9, 0.8, 0.8, 1.3, DUSK);
  m.set(0, 1, -1, VIOLET);         // sheen streak
  return m.build(S, true);
}

function makeTailSeg3(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 0.6, -0.7, 0.6, 0.6, 1.0, VIOLET);
  m.setEmissive(0, 0, -2, GLOW, 0.4); // already coming apart at the end
  return m.build(S, true);
}

function glowMaterial(mesh: THREE.Mesh, emissiveHex: number, intensity: number, opacity?: number): void {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.emissive = new THREE.Color(emissiveHex);
  mat.emissiveIntensity = intensity;
  if (opacity !== undefined) {
    mat.transparent = true;
    mat.opacity = opacity;
  }
}

/** One detached tail mote — a single cube, never a stack: silhouette first. */
function makeWisp(color: number, bright: boolean): THREE.Mesh {
  const m = new VoxelModel();
  // Trimmed for the bloom pass: a wisp is a mote of dusk, and at 1.0 the three
  // of them became white pinpricks brighter than the cat itself.
  m.setEmissive(0, 0, 0, bright ? LAV : color, bright ? 0.6 : 0.5);
  const mesh = m.build(S, true);
  mesh.castShadow = false;
  return mesh;
}

function makeGlowPool(): THREE.Mesh {
  // A single soft slab — the four outrigger cubes just added silhouette noise.
  const m = new VoxelModel();
  m.box(-1, 0, -2, 1, 0, 2, GLOW);
  const mesh = m.build(S, true);
  glowMaterial(mesh, 0x6b48c8, 0.5, 0.6);
  mesh.castShadow = false;
  return mesh;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.12, 0);
  body.add(torso);

  // Pool of soft light the cat hovers on.
  const glow = new THREE.Group();
  glow.position.set(0, GLOW_Y, 0);
  body.add(glow);
  const glowMesh = makeGlowPool();
  glowMesh.position.set(0, -0.04, 0);
  glow.add(glowMesh);

  // Fake bloom: soft violet halo tucked under the belly. NON-additive so it
  // deepens the underglow without washing the dark coat out; parented to the
  // body (not the glow group, whose non-uniform scaling would distort it).
  const bodyGlow = makeGlowSprite(0x8f6fd6, 0.35, 0.25, THREE.NormalBlending);
  bodyGlow.position.set(0, -0.14, 0);
  body.add(bodyGlow);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  headMesh.position.set(0, -0.11, 0.02);
  head.add(headMesh);

  // |x| = 0.155, out from 0.10. The skull is 2.7 cells of half-width, i.e. 0.23
  // units, so at 0.10 the two ears sat side by side over the middle of a wide head
  // and the crown read as one smooth dome with a couple of bumps on it. At 0.155
  // they stand on the skull's outer corners, which is where a cat's ears are and
  // what gives the head its triangular top. The ear MESH is untouched on purpose:
  // its top cell is the highest voxel on the rig, so growing it would move
  // `silhouetteTop` and with it the mount-form scale BeastActor derives from it.
  // Sliding the ears sideways buys the silhouette at zero cost to that.
  const earL = new THREE.Group();
  earL.position.set(0.155, 0.13, -0.03);
  earL.rotation.z = -EAR_Z;
  head.add(earL);
  const earLMesh = makeEar(1);
  earLMesh.position.set(0, -0.02, 0);
  earL.add(earLMesh);

  const earR = new THREE.Group();
  earR.position.set(-0.155, 0.13, -0.03);
  earR.rotation.z = EAR_Z;
  head.add(earR);
  const earRMesh = makeEar(-1);
  earRMesh.position.set(0, -0.02, 0);
  earR.add(earRMesh);

  // Tucked forepaws that dangle under the chest.
  const mkPaw = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.06, 0.18);
    g.rotation.x = PAW_X;
    body.add(g);
    const mesh = makePaw();
    mesh.position.set(0, -0.14, -0.02);
    g.add(mesh);
    return g;
  };
  const legFL = mkPaw(0.11);
  const legFR = mkPaw(-0.11);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, 0.05, -0.24);
  tailBase.rotation.x = TAIL_BASE_X;
  body.add(tailBase);
  const seg1 = makeTailSeg1();
  seg1.position.set(0, -0.09, -0.05);
  tailBase.add(seg1);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, 0.02, -0.2);
  tailMid.rotation.x = TAIL_MID_X;
  tailBase.add(tailMid);
  const seg2 = makeTailSeg2();
  seg2.position.set(0, -0.07, -0.04);
  tailMid.add(seg2);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0.02, -0.16);
  tailTip.rotation.x = TAIL_TIP_X;
  tailMid.add(tailTip);
  const seg3 = makeTailSeg3();
  seg3.position.set(0, -0.06, -0.03);
  tailTip.add(seg3);

  // Detached tail-tip wisps: the tail dissolves into these. Parented to the
  // body so they ride the hover; animate() drives them lagging/orbiting.
  const mkWisp = (color: number, tall: boolean, i: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(0, -0.05, -0.5 - 0.1 * i);
    body.add(g);
    const mesh = makeWisp(color, tall);
    mesh.position.set(-0.04, -0.04, -0.04);
    g.add(mesh);
    return g;
  };
  const wisp1 = mkWisp(GLOW, true, 0);
  const wisp2 = mkWisp(GLOW, false, 1);
  const wisp3 = mkWisp(LAV, false, 2);

  return {
    root,
    parts: {
      body, glow, head, earL, earR, legFL, legFR,
      tailBase, tailMid, tailTip, wisp1, wisp2, wisp3,
    },
    height: 0.8,
    radius: 0.3,
  };
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);

  // Ghostly ever-present hover bob.
  const hover = 0.045 * Math.sin(t * 1.5) + 0.02 * Math.sin(t * 2.7 + 1.3);

  // Pose state — everything is written every frame.
  let bpx = 0, bpy = BODY_Y + hover, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0;
  let elx = -0.06, elz = -EAR_Z, erx = -0.06, erz = EAR_Z;
  let pawL = PAW_X, pawR = PAW_X;
  let tbx = TAIL_BASE_X, tby = 0, tmx = TAIL_MID_X, tmy = 0, tty = 0;
  let glowS = 1;
  // Wisp behaviour knobs.
  let wSpeed = 1.2, wSpread = 0.1, wTrail = 0.1, wRise = 0, wScatter = 0, wRing = 0;

  switch (ctx.action) {
    case 'idle': {
      // Slow breathing, drowsy looks, lazy S-wave tail, wisps drifting.
      const b = Math.sin(t * 1.9);
      bsy = 1 + 0.025 * b;
      bsx = bsz = 1 - 0.01 * b;
      bry = 0.07 * Math.sin(t * 0.42);
      brz = 0.03 * Math.sin(t * 0.9 + 2);
      hrx = 0.05 * Math.sin(t * 1.05 + 0.6);
      hry = 0.22 * Math.sin(t * 0.27);
      hrz = 0.04 * Math.sin(t * 0.5) + 0.26 * Math.max(0, Math.sin(t * 0.33 + 1.1)) ** 12; // slow head tilt
      elx = erx = -0.06 + 0.03 * b;
      elz -= 0.3 * Math.max(0, Math.sin(t * 1.07 + 2.3)) ** 16; // independent ear flicks
      erz += 0.3 * Math.max(0, Math.sin(t * 0.89 + 4.7)) ** 16;
      pawL = PAW_X + 0.08 * Math.sin(t * 1.6 + 0.4);
      pawR = PAW_X + 0.08 * Math.sin(t * 1.6 + 2.5);
      const wv = ctx.cycle(TAIL, 1.15);
      tbx = TAIL_BASE_X + 0.06 * Math.sin(t * 0.8);
      tby = 0.25 * Math.sin(wv);
      tmy = 0.32 * Math.sin(wv - 0.9);
      tty = 0.42 * Math.sin(wv - 1.8);
      glowS = 1 + 0.08 * Math.sin(t * 1.5 + 0.5);
      break;
    }
    case 'walk':
    case 'run':
    case 'fly':
    case 'swim': {
      // No legs, no gait: a serpentine gliding drift, nose down, wisps trailing.
      // 2.2 rad/s drifting to 3.6 at speed (0.35-0.57 Hz).
      const drift = ctx.cycle(DRIFT, 2.2 + 1.4 * ms);
      brx = 0.06 + 0.12 * ms;
      brz = 0.09 * Math.sin(drift) * (0.35 + 0.65 * ms);
      bry = 0.07 * Math.sin(drift - 0.7) * ms;
      bpx = 0.035 * Math.sin(drift) * ms;
      bpy += 0.03 * Math.sin(ctx.cycle(SURGE, 2.6 + 2.2 * ms)) * (0.4 + 0.6 * ms);
      bpz = 0.02 * Math.sin(t * 3.4) * ms; // faint surging
      bsz = 1 + 0.06 * ms; // stretched by its own speed
      bsx = 1 - 0.025 * ms;
      hrx = -brx * 0.7; // gaze steadied against the lean
      hry = -bry * 0.7;
      hrz = -brz * 0.7;
      elx = erx = -0.06 - 0.4 * ms; // ears swept back
      pawL = PAW_X - 0.4 * ms + 0.06 * Math.sin(t * 3.1);
      pawR = PAW_X - 0.4 * ms + 0.06 * Math.sin(t * 3.1 + 2.2);
      tbx = TAIL_BASE_X - 0.35 * ms; // tail streams out behind
      tmx = TAIL_MID_X - 0.15 * ms;
      // The tail wave rides 1.1x the body drift. It goes through the TAIL slot at
      // that rate rather than being derived as `drift * 1.1`, so the wave is also
      // continuous across the idle/moving boundary and not just within a branch.
      const wv = ctx.cycle(TAIL, (2.2 + 1.4 * ms) * 1.1);
      tby = 0.22 * Math.sin(wv);
      tmy = 0.3 * Math.sin(wv - 1);
      tty = 0.4 * Math.sin(wv - 2);
      glowS = 1 + 0.1 * ms;
      wSpeed = 2 + 2 * ms;
      wTrail = 0.1 + 0.14 * ms; // wisps lag further at speed
      wSpread = 0.08;
      break;
    }
    case 'attack': {
      // Phantom claw: coil back with a paw wound high, then rake through.
      const wind = smooth(phase(at, 0, 0.15));
      const lunge = ezOut(phase(at, 0.15, 0.3));
      const rec = smooth(phase(at, 0.5, 0.85));
      const k = -wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.26 * k;
      bpy += 0.05 * wind * (1 - lunge) - 0.03 * kp;
      brx = 0.18 * k;
      bsz = 1 + 0.15 * kp;
      bsx = 1 - 0.06 * kp;
      hrx = 0.12 * k;
      elx = erx = -0.7 * kp - 0.25 * wind;
      pawL = PAW_X - 1.3 * wind * (1 - lunge) + 1.6 * kp; // the raking paw
      pawR = PAW_X - 0.9 * wind * (1 - lunge) + 1.1 * kp;
      tbx = TAIL_BASE_X + 0.3 * wind * (1 - lunge) - 0.4 * kp;
      tby = 0.12 * Math.sin(at * 26) * (1 - rec);
      glowS = 1 + 0.3 * kp;
      wSpeed = 3 + 5 * kp;
      wTrail = 0.06;
      wScatter = 0.3 * kp;
      break;
    }
    case 'cast': {
      // Rear-up flourish: paws raised, wisps pulled into a tight fast spiral.
      const rise = ezOut(clamp01(at / 0.45));
      const trem = 0.5 * Math.sin(t * 13) + 0.5 * Math.sin(t * 19);
      brx = -0.5 * rise + 0.02 * trem * rise;
      bpy += 0.11 * rise;
      bpz = -0.03 * rise;
      hrx = 0.32 * rise; // eyes stay on the target
      elx = erx = 0.15 * rise;
      pawL = PAW_X - 1.5 * rise + 0.2 * Math.sin(t * 8) * rise;
      pawR = PAW_X - 1.5 * rise + 0.2 * Math.sin(t * 8 + Math.PI) * rise;
      tbx = TAIL_BASE_X + 0.45 * rise;
      tmx = TAIL_MID_X + 0.25 * rise;
      tby = 0.08 * Math.sin(t * 9);
      tmy = 0.1 * Math.sin(t * 9 - 0.7);
      glowS = 1 + 0.35 * rise + 0.15 * Math.sin(t * 10) * rise;
      wSpeed = 5.5;
      wSpread = 0.06 + 0.16 * rise;
      wTrail = 0.02;
      wRise = 0.25 * rise;
      wRing = 0.8 * rise;
      break;
    }
    case 'special': {
      // Umbral bloom: rises spinning while the wisps fling into a wide halo.
      const T = 0.9;
      const k = clamp01(at / T);
      const arc = Math.sin(Math.PI * k);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.25)) * (1 - smooth(phase(at, T + 0.25, T + 0.6)));
      bry = Math.PI * 2 * smooth(k);
      bpy += 0.26 * arc - 0.05 * land;
      bsy = 1 + 0.1 * arc - 0.18 * land;
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      brx = -0.2 * arc + 0.1 * land;
      hrx = -0.15 * arc;
      elx = erx = -0.5 * arc;
      pawL = pawR = PAW_X - 1.2 * arc;
      tbx = TAIL_BASE_X + 0.5 * arc;
      tby = 0.4 * Math.sin(at * 15);
      tmy = 0.5 * Math.sin(at * 15 - 0.8);
      tty = 0.6 * Math.sin(at * 15 - 1.6);
      glowS = 1 + 0.8 * arc + 0.4 * land;
      wRing = 1;
      wSpeed = 7;
      wSpread = 0.22 + 0.2 * arc;
      wRise = 0.1 * arc;
      break;
    }
    case 'hurt': {
      // A ghost's flinch: it flickers, ears pinned, wisps scattering.
      const d = Math.exp(-3.5 * at);
      const flick = Math.abs(Math.sin(at * 38));
      bpx = 0.04 * Math.sin(at * 44) * d;
      bpz = -0.13 * d;
      bpy += -0.06 * d;
      brz = 0.1 * Math.sin(at * 32) * d;
      bsx = bsy = bsz = 1 - 0.12 * flick * d; // shape destabilizes
      hrx = -0.28 * d;
      hrz = 0.1 * Math.sin(at * 28) * d;
      elx = erx = -0.9 * d;
      pawL = pawR = PAW_X - 0.3 * d;
      tbx = TAIL_BASE_X - 0.5 * d; // tail wilts
      tmx = TAIL_MID_X - 0.3 * d;
      glowS = 1 - 0.4 * d + 0.15 * flick * d;
      wScatter = d;
      wSpeed = 4;
      wSpread = 0.18;
      break;
    }
    case 'happy': {
      // Bouncing hover with a periodic full joy-spin and frantic tail wags.
      const hop = Math.abs(Math.sin(at * 4.8));
      bpy += 0.12 * hop;
      bry = Math.PI * 2 * smooth(clamp01(((at % 2.4) - 0.3) / 0.8)); // spin! (2*PI wraps clean)
      brz = 0.05 * Math.sin(at * 9.6);
      bsy = 0.94 + 0.12 * hop;
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      hrx = -0.1;
      hrz = 0.22 * Math.sin(at * 2.6 + 1);
      elz = -EAR_Z - 0.15 * hop;
      erz = EAR_Z + 0.15 * hop;
      elx = erx = 0.1 - 0.2 * hop;
      pawL = PAW_X - 0.5 * hop + 0.15 * Math.sin(at * 9.6);
      pawR = PAW_X - 0.5 * hop + 0.15 * Math.sin(at * 9.6 + Math.PI);
      const wag = at * 14;
      tbx = TAIL_BASE_X + 0.2;
      tby = 0.5 * Math.sin(wag);
      tmy = 0.6 * Math.sin(wag - 0.6);
      tty = 0.7 * Math.sin(wag - 1.2);
      glowS = 1.15 + 0.15 * Math.sin(at * 7);
      wSpeed = 4.5;
      wSpread = 0.14;
      wRise = 0.06 * hop;
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, HEAD_Y, HEAD_Z);
  p.head.rotation.set(hrx, hry, hrz);
  p.earL.rotation.set(elx, 0, elz);
  p.earR.rotation.set(erx, 0, erz);
  p.legFL.rotation.set(pawL, 0, 0.06 * Math.sin(t * 2.1));
  p.legFR.rotation.set(pawR, 0, -0.06 * Math.sin(t * 2.1 + 1));
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailMid.rotation.set(tmx, tmy, 0);
  p.tailTip.rotation.set(TAIL_TIP_X + 0.04 * Math.sin(t * 6.3), tty, 0.05 * Math.sin(t * 7.7));
  p.glow.scale.set(glowS, 1, glowS * (1 + 0.15 * ms));
  p.glow.position.set(0, GLOW_Y + 0.008 * Math.sin(t * 3.3), 0);

  // Detached tail wisps: lag behind in a loose trail, or swing into a halo.
  const phases = [0, 2.09, 4.19];
  // One integrated orbit phase for all three wisps; they differ only by a fixed
  // offset, and the 1.6x / 0.9x / 2x harmonics below are constant multiples of
  // it, which stay continuous.
  const wa = ctx.cycle(WISP, wSpeed);
  for (let i = 0; i < 3; i++) {
    const w = p[`wisp${i + 1}`];
    const a = wa + phases[i];
    const r = wSpread * (0.7 + 0.3 * i);
    // Trail mode: loitering behind the dissolving tail tip.
    const trailX = r * Math.sin(a + i);
    const trailY = -0.06 + wRise + 0.05 * Math.sin(a * 1.6 + i * 1.3);
    const trailZ = -0.44 - wTrail * (i + 1) + r * 0.7 * Math.cos(a * 0.9);
    // Ring mode: orbiting the whole body.
    const ringX = (0.3 + wSpread) * Math.sin(a);
    const ringY = 0.05 + wRise + 0.04 * Math.sin(a * 2 + i);
    const ringZ = -0.05 + (0.3 + wSpread) * Math.cos(a);
    const jx = wScatter * 0.07 * Math.sin(t * 29 + i * 7);
    const jy = wScatter * 0.07 * Math.sin(t * 33 + i * 5);
    w.position.set(
      trailX + (ringX - trailX) * wRing + jx,
      trailY + (ringY - trailY) * wRing + jy,
      trailZ + (ringZ - trailZ) * wRing,
    );
    const sc = 0.75 + 0.3 * Math.sin(t * 4.2 + i * 2.2) ** 2;
    w.scale.setScalar(sc * (1 - 0.25 * wScatter));
    w.rotation.set(0, t * (1.5 + i), 0);
  }
}

export const skills: SkillDef[] = [
  {
    id: 'umbrakit.gloom-bolt',
    nameKey: 'skill.umbrakit.gloom-bolt.name',
    descriptionKey: 'skill.umbrakit.gloom-bolt.desc',
    element: 'shadow',
    targeting: 'projectile',
    cost: 6,
    cooldown: 1.7,
    power: 11,
    range: 15,
    learnAtLevel: 1,
    castAnim: 'cast',
  },
  {
    id: 'umbrakit.phantom-claw',
    nameKey: 'skill.umbrakit.phantom-claw.name',
    descriptionKey: 'skill.umbrakit.phantom-claw.desc',
    element: 'shadow',
    targeting: 'melee',
    cost: 9,
    cooldown: 3,
    power: 18,
    range: 2.4,
    learnAtLevel: 4,
    castAnim: 'attack',
  },
  {
    id: 'umbrakit.veil-of-dusk',
    nameKey: 'skill.umbrakit.veil-of-dusk.name',
    descriptionKey: 'skill.umbrakit.veil-of-dusk.desc',
    element: 'shadow',
    targeting: 'self',
    cost: 12,
    cooldown: 9,
    power: 14,
    range: 1,
    storePrice: 160,
    castAnim: 'cast',
  },
  {
    id: 'umbrakit.midnight-bloom',
    nameKey: 'skill.umbrakit.midnight-bloom.name',
    descriptionKey: 'skill.umbrakit.midnight-bloom.desc',
    element: 'shadow',
    targeting: 'aoe',
    cost: 25,
    cooldown: 12,
    power: 44,
    range: 5,
    storePrice: 400,
    castAnim: 'special',
  },
];

export const species: BeastSpecies = {
  id: 'umbrakit',
  nameKey: 'beast.umbrakit.name',
  element: 'shadow',
  locomotion: 'ground',
  descriptionKey: 'beast.umbrakit.desc',
  baseStats: { maxHp: 44, attack: 13, defense: 5, speed: 5.4 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
