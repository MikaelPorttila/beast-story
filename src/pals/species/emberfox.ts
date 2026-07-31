import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Emberfox — a small, eager fire fox with a magnificent flame-tipped tail.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette
const ORANGE = 0xf3712b;   // ember-orange coat
const ORANGE_LIT = 0xff9c52; // sunlit crest along back, crown and tail
const RUSSET = 0xcc4e14;   // deeper saddle along the back / shaded underside
const CREAM = 0xffe9c4;    // chest / muzzle / belly
const CREAM_DK = 0xe6c9a0; // muzzle top: a step below the chest cream so the eyes
                           // stay the brightest thing on the face
const MUZZLE_DK = 0xc9a877; // muzzle's forward step / underside
const SOCK = 0x54322b;     // dark socks, ear tips, brows
const NOSE = 0x33201c;
// The eye is the DARK mass and the face is light — the reverse of the previous
// build, where a near-white iris dissolved into the cream muzzle and left one lone
// black cell reading as a bandit dot. Dark RUST, not black: it keeps the fox's hue
// so the eye is wet rather than a hole cut in the head.
const IRIS = 0x2e1510;
const EYE_SHINE = 0xfffdf4;  // single catchlight cell
const LID = 0xd85c1e;        // coat one step down. On a CREAM mask the lid only has
                             // to be a shade, not a shadow — pushed darker it merges
                             // with the iris into one band and it is goggles again.
const BRIDGE = 0xf6dcb4;     // snout ridge between the eyes: one step BELOW the
                             // cream mask, not above it. Brighter than the mask it
                             // became a pale block that read as the whole face.
const EAR_PINK = 0xf2a38e;
const FLAME_OUT = 0xffae33; // tail-tip outer flame
const FLAME_MID = 0xffc93f;
const FLAME_CORE = 0xffe066;
const FLAME_HOT = 0xffef9a;  // warm gold, not white: a white core clips to a
                             // featureless blob the moment bloom touches it

// Base pose constants (world / local units, must match buildRig)
const BODY_Y = 0.34;
const HEAD_Y = 0.2;
const HEAD_Z = 0.28;
const EAR_Z = 0.22;      // outward ear tilt magnitude
const TAIL_BASE_X = 0.35; // proud upward tail curl
const TAIL_MID_X = 0.18;
const TAIL_TIP_X = 0.15;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * The leg cycle, on one integrated phase (PalAnimCtx.cycle) shared by the trot,
 * the gallop and the paddle. They are one set of legs changing pace; giving
 * them one slot is what stops the walk/run threshold — which chatters, because
 * the gait blend is a damped value that can sit either side of 0.5 for frames
 * on end — from jump-cutting the pose every time it flips.
 */
const GAIT = 0;
/** The idle tail wave, which drifts at its own rate rather than the gait's. */
const TAIL = 1;

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.8, 0, 2.6, 1.9, 3.8, ORANGE);
  m.ellipsoid(0, 0.4, 0, 2.1, 1.1, 3.2, CREAM);      // belly
  m.ellipsoid(0, 2.8, -0.5, 2.1, 1.2, 2.9, RUSSET);  // saddle
  m.ellipsoid(0, 1.4, 2.8, 1.8, 1.6, 1.4, CREAM);    // fluffy chest ruff
  rimTop(m, ORANGE_LIT, -2, 2, 0, 5, -4, 4);
  shadeUnder(m, RUSSET, -2, 2, 0, 3, -4, 4);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // Skull widened 2.4 -> 2.8 so the face plate has room for an eye pair with plain
  // coat between them rather than eyes hanging off the sides of the head.
  m.ellipsoid(0, 1.8, 0.4, 2.8, 2.0, 2.2, ORANGE);
  // Cream stays low on the snout — when it climbed to the eye line the whole
  // face read as one pale band with two dark holes (bandit mask).
  m.ellipsoid(0, 0.6, 1.9, 1.7, 0.9, 1.2, CREAM);    // lower cheeks
  // Muzzle: a STEPPED snout with a jaw under it, not a cantilevered slab. The old
  // build was a single 3x1x2 cream bar at y=1 projecting two cells past the skull
  // with nothing beneath it — the bar-of-soap read.
  //
  // Two rows tall, topping out at y=1 (one row below the eye line), stepping down a
  // value each z and ending in a single dark nose cell. Two rows is the ceiling: a
  // three-row snout is a brick again, and its top row would stand proud of the face
  // plate directly in front of the inner eye column and hide a third of the iris.
  // The bottom row is coat-colour russet — that is the jaw the pale block sits on.
  for (let x = -1; x <= 1; x++) {
    m.set(x, 1, 3, CREAM_DK);    // lit top / front of the muzzle
    m.set(x, 0, 3, RUSSET);      // jaw line underneath, in coat colour
    m.set(x, 1, 4, MUZZLE_DK);   // second step, one value down
  }
  m.set(0, 0, 4, RUSSET);        // chin point
  m.set(0, 1, 5, NOSE);          // nose caps the taper: 3 wide -> 3 wide -> 1 wide
  // Flat face plate so the eyes sit on a face, not in mid-air. One row taller than
  // before (down to y=1) purely to carry the pale cheek band below the eyes.
  m.box(-3, 1, 2, 3, 4, 2, ORANGE);
  rimTop(m, ORANGE_LIT, -2, 2, 0, 4, -2, 2);
  // z stops at 2, short of the muzzle: run out to z=4 and the cream snout is the
  // lowest cell in its own column, so the shadow pass painted the nose russet.
  shadeUnder(m, RUSSET, -3, 3, 0, 1, -2, 2);
  // A full CREAM MASK over the eye rows — a real red fox's pale cheeks, and the one
  // change that finally made this face read in the game rather than only in the lab.
  // The front of a pal's head is in shade in most portraits (the sun is low and
  // behind), so an orange face plate rendered at ~25% value and the dark iris on it
  // had nothing to separate them. Cream at 25% is still clearly lighter than a dark
  // iris, so the eye survives the shading. Painted after shadeUnder so the underside
  // pass cannot repaint the bottom row russet.
  for (let x = -3; x <= 3; x++) {
    m.set(x, 1, 2, CREAM);
    m.set(x, 2, 2, CREAM);
    m.set(x, 3, 2, CREAM_DK); // upper mask a step down, so the brow above reads
  }
  // Iris rows at y=2,3, lid row landing on y=4 (the top row of the plate) so the
  // brow reads as the fox's dark eyebrow marking rather than a floating ledge.
  // inner: 1, not 2. Both were shot in the real game. At inner: 2 the eyes land on
  // |x| = 2..3, i.e. hard against the edge of a seven-cell plate, and the three-cell
  // bridge between them becomes a big pale block that reads as the face while the
  // eyes wrap round the silhouette. inner: 1 leaves a cell of coat outboard of each
  // eye, which is what keeps both of them presented at three-quarter bearings.
  eyes2x2(m, {
    inner: 1, y: 2, faceZ: 2, iris: IRIS, shine: EYE_SHINE,
    lid: LID, browProud: true, bridge: BRIDGE,
  });
  return m.build(S, true);
}

/**
 * One ear, authored once and mirrored by `sign`. The previous pair took separate
 * tipX / innerX arguments per side, which is exactly the kind of hand-mirroring
 * that lets two halves of a bilateral feature drift — and it gave each ear a
 * single-voxel dark tip, so from three-quarters one ear showed its tip and the
 * other showed a plain orange back and they read as two different ears.
 */
function makeEar(sign: number): THREE.Mesh {
  const m = new VoxelModel();
  const X = (d: number): number => (sign > 0 ? d : -d - 1); // d: 0 inner, 1 outer
  for (const d of [0, 1]) {
    m.set(X(d), 0, 0, ORANGE);
    m.set(X(d), 1, 0, ORANGE);
    m.set(X(d), 0, 1, EAR_PINK);   // pink inner ear facing forward
  }
  // Dark tip as a three-cell diagonal wedge along the OUTER edge, not a full band
  // across both columns: half the ear in near-black read as a rabbit ear.
  m.set(X(0), 2, 0, ORANGE);
  m.set(X(1), 2, 0, SOCK);
  m.set(X(1), 3, 0, SOCK);         // point, leaning outward with the ear tilt
  m.set(X(0), 1, 1, EAR_PINK);
  return m.build(S, true);
}

function makeLeg(back: boolean): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 0, 1, SOCK);   // dark sock paw
  m.box(0, 1, 0, 1, 2, 1, ORANGE);
  if (back) {
    m.set(0, 2, -1, ORANGE);       // haunch bulge
    m.set(1, 2, -1, ORANGE);
  }
  return m.build(S, true);
}

function makeTailSeg1(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.2, -1.5, 1.3, 1.3, 1.9, ORANGE);
  return m.build(S, true);
}

function makeTailSeg2(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.8, -1.6, 2.2, 2.2, 2.7, ORANGE);  // the magnificent floof
  m.ellipsoid(0, 0.9, -1.6, 1.6, 1.0, 2.1, RUSSET);  // shadowed underside
  return m.build(S, true);
}

function makeTailTip(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.4, -1.4, 1.7, 1.7, 2.1, FLAME_OUT);
  m.ellipsoid(0, 1.4, -2.4, 1.1, 1.1, 1.5, FLAME_MID); // hotter toward the tip
  m.set(0, 1, -4, FLAME_CORE);                          // trailing licks
  m.set(0, 2, -4, FLAME_HOT);
  // The flame glows for real: gradient brightens toward the tip. Every value here
  // is roughly half what it was — a bloom pass now amplifies emissive, and at the
  // old 1.2-1.8 the tail was a single white star with no flame shape left in it.
  // Halved again from 0.6-1.0. In real-game portraits the tail was a single blown
  // white star with the flame shape entirely lost inside it; at 0.3-0.55 the
  // gradient survives and a bloom pass adds the halo rather than the whole read.
  m.markEmissive(FLAME_OUT, 0.30);
  m.markEmissive(FLAME_MID, 0.38);
  m.markEmissive(FLAME_CORE, 0.46);
  m.markEmissive(FLAME_HOT, 0.55);
  return m.build(S, true);
}

function makeFlame(): THREE.Mesh {
  const m = new VoxelModel();
  // Wide 1-voxel skirt so the flame stays rooted in the tail-tip floof.
  m.set(0, 0, 0, FLAME_MID);
  m.set(1, 0, 0, FLAME_MID);
  m.set(-1, 0, 0, FLAME_MID);
  m.set(0, 0, -1, FLAME_MID);
  m.set(0, 1, 0, FLAME_CORE);
  m.set(1, 1, 0, FLAME_CORE);
  m.set(0, 2, 0, FLAME_HOT);
  m.markEmissive(FLAME_MID, 0.38);
  m.markEmissive(FLAME_CORE, 0.46);
  m.markEmissive(FLAME_HOT, 0.55);
  return m.build(S, true);
}

/** A single glowing ember mote that flickers near the flame. */
function makeEmber(color: number, intensity: number): THREE.Mesh {
  const m = new VoxelModel();
  m.setEmissive(0, 0, 0, color, intensity);
  return m.build(S, true);
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
  // +0.11z, not +0.06: the stepped snout adds a cell of length and build() centres
  // on the bounding box, so without it the whole skull slides back into the ruff.
  headMesh.position.set(0, -0.16, 0.11);
  head.add(headMesh);

  const earL = new THREE.Group();
  earL.position.set(0.15, 0.26, -0.05);
  earL.rotation.z = -EAR_Z;
  head.add(earL);
  const earLMesh = makeEar(1);
  earLMesh.position.set(0, -0.02, 0);
  earL.add(earLMesh);

  const earR = new THREE.Group();
  earR.position.set(-0.15, 0.26, -0.05);
  earR.rotation.z = EAR_Z;
  head.add(earR);
  const earRMesh = makeEar(-1);
  earRMesh.position.set(0, -0.02, 0);
  earR.add(earRMesh);

  const mkLegGroup = (x: number, z: number, back: boolean): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.04, z);
    body.add(g);
    const mesh = makeLeg(back);
    mesh.position.set(0, -0.3, 0);
    g.add(mesh);
    return g;
  };
  const legFL = mkLegGroup(0.15, 0.2, false);
  const legFR = mkLegGroup(-0.15, 0.2, false);
  const legBL = mkLegGroup(0.15, -0.22, true);
  const legBR = mkLegGroup(-0.15, -0.22, true);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, 0.1, -0.32);
  tailBase.rotation.x = TAIL_BASE_X;
  body.add(tailBase);
  const seg1 = makeTailSeg1();
  seg1.position.set(0, -0.12, -0.12);
  tailBase.add(seg1);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, 0.04, -0.26);
  tailMid.rotation.x = TAIL_MID_X;
  tailBase.add(tailMid);
  const seg2 = makeTailSeg2();
  seg2.position.set(0, -0.22, -0.1);
  tailMid.add(seg2);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0.06, -0.34);
  tailTip.rotation.x = TAIL_TIP_X;
  tailMid.add(tailTip);
  const tipMesh = makeTailTip();
  tipMesh.position.set(0, -0.16, -0.06);
  tailTip.add(tipMesh);

  // Flame crest sits ROOTED in the tail-tip mesh (base skirt buried a voxel
  // deep) so it can never read as detached, whatever the tail wave does.
  const flame = new THREE.Group();
  flame.position.set(0, 0.0, -0.24);
  tailTip.add(flame);
  const flameMesh = makeFlame();
  flameMesh.position.set(0, -0.02, 0);
  flame.add(flameMesh);

  // Soft warm-orange halo on the flame tip. Parented to tailTip — not flame —
  // so the flame's non-uniform flicker scaling never distorts the billboard; it
  // still rides the tail.
  //
  // 0.20 / 0.06, down from 0.34 / 0.12. The old pair was written when this sprite
  // WAS the glow; a selective emissive bloom pass exists now and blooms the flame
  // voxels too, so the sprite was adding a second, larger, perfectly round halo on
  // top. A real-game capture (cam=2.6,2.4,3.0, look=0,1.6,0) showed the result as a
  // shapeless warm orb about as wide as the fox's head, hanging at head height
  // where the tail curls up over the back — the flame's own tapered shape was
  // entirely inside it. At 0.20/0.06 the halo is a hint of heat-haze around a
  // flame you can still see the shape of. See glowsprite.ts.
  const flameGlow = makeGlowSprite(0xffb347, 0.20, 0.06);
  flameGlow.position.set(0, 0.1, -0.28);
  tailTip.add(flameGlow);

  // Two tiny ember motes that flicker just off the flame.
  const ember1 = new THREE.Group();
  ember1.position.set(0.13, 0.12, -0.34);
  tailTip.add(ember1);
  ember1.add(makeEmber(FLAME_CORE, 0.5));

  const ember2 = new THREE.Group();
  ember2.position.set(-0.11, 0.22, -0.2);
  tailTip.add(ember2);
  ember2.add(makeEmber(FLAME_HOT, 0.6));

  return {
    root,
    parts: {
      body, head, earL, earR, legFL, legFR, legBL, legBR,
      tailBase, tailMid, tailTip, flame, ember1, ember2,
    },
    height: 1.0,
    radius: 0.35,
  };
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.4);

  // Pose state (idle-ish defaults) — everything is written every frame.
  let bpx = 0, bpy = BODY_Y + 0.004 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.012 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0, hpy = HEAD_Y, hpz = HEAD_Z;
  let elx = -0.05, elz = -EAR_Z, erx = -0.05, erz = EAR_Z;
  let flrx = 0, frrx = 0, blrx = 0, brrx = 0;
  let tbx = TAIL_BASE_X, tby = 0, tmx = TAIL_MID_X, tmy = 0, ttx = TAIL_TIP_X, tty = 0;
  let flameBoost = 0;

  switch (ctx.action) {
    case 'idle': {
      bsy = 1 + 0.03 * br;
      bsx = bsz = 1 - 0.012 * br;
      bpy += 0.004 * br;
      hrx = 0.06 * Math.sin(t * 1.1 + 0.7);
      hry = 0.1 * Math.sin(t * 0.21);
      // curious head tilt "blink" pulses
      hrz = 0.05 * Math.sin(t * 0.53) + 0.3 * Math.max(0, Math.sin(t * 0.37 + 1.2)) ** 12;
      elx = erx = -0.05 + 0.04 * br;
      // independent ear flicks
      elz -= 0.35 * Math.max(0, Math.sin(t * 1.13 + 2.0)) ** 16;
      erz += 0.35 * Math.max(0, Math.sin(t * 0.97 + 4.1)) ** 16;
      // eager little front-paw tap
      flrx = -0.5 * Math.max(0, Math.sin(t * 0.61 + 0.9)) ** 10;
      const wave = ctx.cycle(TAIL, 1.7);
      tbx = TAIL_BASE_X + 0.05 * Math.sin(t * 1.1);
      tby = 0.28 * Math.sin(wave);
      tmy = 0.34 * Math.sin(wave - 0.8);
      tty = 0.4 * Math.sin(wave - 1.6);
      break;
    }
    case 'walk':
    case 'run':
    case 'fly': { // ground pal: treat stray 'fly' as a sprint
      const isRun = ctx.action !== 'walk';
      // 5.5-8 rad/s trotting, 8.5-12 galloping. INTEGRATED rather than `t * f`:
      // both the moveSpeed term AND the walk/run step change this frequency, so
      // multiplying it into the session clock teleported the phase twice over.
      // Measured with tools/test-palanim.mjs at a 42 s clock: 1.72 rad of leg
      // rotation in a single frame, and 0.72 rad at the tail tip — the "tails
      // flicker" half of the report. Integrated, the same run peaks at 0.24.
      const f = isRun ? 8.5 + 3.5 * ms : 5.5 + 2.5 * ms;
      const ph = ctx.cycle(GAIT, f);
      const amp = (isRun ? 0.85 : 0.55) * (0.5 + 0.5 * ms);
      if (isRun) {
        // gallop: front pair near-in-phase, back pair opposite
        flrx = amp * Math.sin(ph);
        frrx = amp * Math.sin(ph + 0.45);
        blrx = amp * Math.sin(ph + Math.PI);
        brrx = amp * Math.sin(ph + Math.PI + 0.45);
        bpy += 0.05 * Math.max(0, Math.sin(ph + 0.3));
      } else {
        // trot: diagonal pairs
        flrx = brrx = amp * Math.sin(ph);
        frrx = blrx = amp * Math.sin(ph + Math.PI);
        bpy += 0.02 * Math.sin(ph * 2 + 0.6);
      }
      bsy = 1 + (isRun ? 0.06 : 0.03) * Math.sin(ph * 2 + 1.1);
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      brx = (isRun ? 0.1 : 0.05) * ms + 0.03 * Math.sin(ph * 2);
      bry = 0.04 * Math.sin(ph);
      brz = (isRun ? 0.02 : 0.04) * Math.sin(ph);
      hrx = -0.08 * ms - 0.04 * Math.sin(ph * 2 + 1.5);
      hry = 0.05 * Math.sin(ph);
      elx = erx = -0.45 * ms * (isRun ? 1 : 0.4) + 0.06 * Math.sin(ph * 2);
      // Tail streams behind and whips with the gait — at 0.9x the leg rate, so
      // it reads as following the body rather than being bolted to it. It goes
      // through the TAIL slot at `f * 0.9` rather than being derived as
      // `ph * 0.9`, so that the tail wave is continuous across idle/run/swim
      // too and not just within the gait.
      const wave = ctx.cycle(TAIL, f * 0.9);
      tbx = TAIL_BASE_X - 0.3 * ms * (isRun ? 1 : 0.5);
      tmx = TAIL_MID_X - 0.1 * ms;
      ttx = TAIL_TIP_X + 0.05 * Math.sin(ph * 2);
      tby = 0.25 * Math.sin(wave);
      tmy = 0.35 * Math.sin(wave - 0.9);
      tty = 0.45 * Math.sin(wave - 1.8);
      break;
    }
    case 'swim': { // doggy paddle, nose proudly above water
      const ph = ctx.cycle(GAIT, 7);
      brx = -0.22;
      bpy += 0.02 * Math.sin(t * 2.3);
      hrx = -0.25;
      flrx = 0.7 + 0.5 * Math.sin(ph);
      frrx = 0.7 + 0.5 * Math.sin(ph + Math.PI);
      blrx = 0.5 + 0.4 * Math.sin(ph + 1.5);
      brrx = 0.5 + 0.4 * Math.sin(ph + 1.5 + Math.PI);
      tbx = 0.15;
      const wave = ctx.cycle(TAIL, 3);
      tby = 0.4 * Math.sin(wave);
      tmy = 0.5 * Math.sin(wave - 1);
      tty = 0.6 * Math.sin(wave - 2);
      flameBoost = -0.4; // damp, guttering flame
      break;
    }
    case 'attack': {
      const wind = smooth(phase(at, 0, 0.12));
      const lunge = ezOut(phase(at, 0.12, 0.26));
      const rec = smooth(phase(at, 0.42, 0.75));
      const k = -0.7 * wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.2 * k;
      bpy += -0.05 * wind * (1 - lunge) + 0.02 * kp;
      brx = 0.12 * k;
      bsz = 1 + 0.15 * kp;
      bsx = 1 - 0.06 * kp;
      hrx = 0.18 * k;
      hpz = HEAD_Z + 0.05 * kp;
      elx = erx = -0.6 * kp - 0.2 * wind;
      flrx = frrx = -0.9 * kp + 0.5 * wind * (1 - lunge);
      blrx = brrx = 0.7 * kp - 0.4 * wind * (1 - lunge);
      tbx = TAIL_BASE_X - 0.4 * kp;
      tby = 0.12 * Math.sin(at * 25) * (1 - rec);
      flameBoost = 0.4 * kp;
      break;
    }
    case 'cast': {
      const rise = ezOut(clamp01(at / 0.4));
      const tremor = 0.5 * Math.sin(t * 13) + 0.5 * Math.sin(t * 19);
      brx = -0.55 * rise + 0.02 * tremor * rise;
      bpy += 0.1 * rise;
      bpz = -0.04 * rise;
      hrx = 0.3 * rise + 0.03 * tremor * rise; // keep gaze locked on target
      flrx = -1.3 * rise + 0.25 * Math.sin(t * 7) * rise;
      frrx = -1.3 * rise + 0.25 * Math.sin(t * 7 + Math.PI) * rise;
      blrx = brrx = 0.5 * rise;
      elx = erx = 0.15 * rise;
      elz = -EAR_Z + 0.1 * rise;
      erz = EAR_Z - 0.1 * rise;
      tbx = TAIL_BASE_X + 0.4 * rise;
      tmx = TAIL_MID_X + 0.2 * rise;
      tby = 0.08 * Math.sin(t * 9);
      tmy = 0.1 * Math.sin(t * 9 - 0.7);
      flameBoost = 0.8 * rise;
      break;
    }
    case 'special': { // leaping fire-spin flourish
      const T = 0.75;
      const k2 = clamp01(at / T);
      const tuck = Math.sin(Math.PI * k2);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.22)) * (1 - smooth(phase(at, T + 0.22, T + 0.55)));
      bry = Math.PI * 2 * smooth(k2);
      bpy += 0.28 * tuck;
      bsy = 1 - 0.22 * land;
      bsx = bsz = 1 + 0.12 * land;
      brx = -0.15 * tuck;
      hrx = -0.2 * tuck + 0.1 * land;
      flrx = frrx = -0.9 * tuck + 0.3 * land;
      blrx = brrx = 0.8 * tuck - 0.3 * land;
      elx = erx = 0.2 * tuck;
      tbx = TAIL_BASE_X + 0.45 * tuck;
      tmx = TAIL_MID_X + 0.25 * tuck;
      tby = 0.3 * Math.sin(at * 20) * tuck;
      tty = 0.4 * Math.sin(at * 20 - 1) * tuck;
      flameBoost = 1.2 * tuck + 0.3 * land;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.5 * at);
      bpx = 0.04 * Math.sin(at * 42) * d;
      bpz = -0.1 * d;
      bpy -= 0.05 * d;
      brz = 0.08 * Math.sin(at * 35 + 1) * d;
      hrx = -0.25 * d;
      hrz = 0.1 * Math.sin(at * 30) * d;
      elx = erx = -0.8 * d;
      flrx = frrx = 0.2 * d;
      blrx = brrx = -0.2 * d;
      tbx = TAIL_BASE_X - 0.55 * d; // tail tucked
      tmx = TAIL_MID_X - 0.35 * d;
      flameBoost = -0.5 * d;
      break;
    }
    case 'happy': {
      const hf = 5.2;
      const hop = Math.abs(Math.sin(at * hf));
      bpy += 0.14 * hop;
      bsy = 0.9 + 0.2 * hop;
      bsx = bsz = 1 - 0.5 * (bsy - 1);
      bry = 0.25 * Math.sin(at * 2.6);
      brz = 0.06 * Math.sin(at * hf * 2);
      hrx = -0.1;
      hrz = 0.22 * Math.sin(at * 2.6 + 1);
      elz = -EAR_Z - 0.18 * hop;
      erz = EAR_Z + 0.18 * hop;
      elx = erx = 0.1 - 0.15 * hop;
      flrx = -0.3 * hop + 0.15 * Math.sin(at * hf * 2);
      frrx = -0.3 * hop + 0.15 * Math.sin(at * hf * 2 + Math.PI);
      blrx = brrx = 0.2 * hop;
      const wag = at * 16;
      tbx = 0.65;
      tby = 0.5 * Math.sin(wag);
      tmy = 0.6 * Math.sin(wag - 0.6);
      tty = 0.7 * Math.sin(wag - 1.2);
      flameBoost = 0.5 + 0.2 * Math.sin(at * 8);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, hpy, hpz);
  p.head.rotation.set(hrx, hry, hrz);
  p.earL.rotation.set(elx, 0, elz);
  p.earR.rotation.set(erx, 0, erz);
  p.legFL.rotation.set(flrx, 0, 0);
  p.legFR.rotation.set(frrx, 0, 0);
  p.legBL.rotation.set(blrx, 0, 0);
  p.legBR.rotation.set(brrx, 0, 0);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailMid.rotation.set(tmx, tmy, 0);
  p.tailTip.rotation.set(ttx, tty, 0.03 * Math.sin(t * 10.4));

  // Tail flame never stops flickering.
  const fl = 1 + flameBoost + 0.18 * Math.sin(t * 11.7) + 0.12 * Math.sin(t * 17.3 + 1.7);
  p.flame.scale.set(
    0.85 + 0.1 * Math.sin(t * 15.1 + 0.5),
    Math.max(0.2, fl),
    0.85 + 0.1 * Math.sin(t * 13.7),
  );
  p.flame.rotation.set(0.18 * Math.sin(t * 9.3 + 2.1), 0, 0.22 * Math.sin(t * 12.6));

  // Ember motes: cheap flicker — pulse scale and bob, brighter when the flame is.
  const eb = Math.max(0, flameBoost);
  const e1 = 0.45 + 0.5 * Math.max(0, Math.sin(t * 8.3 + 0.7)) ** 2 + 0.3 * eb;
  const e2 = 0.4 + 0.5 * Math.max(0, Math.sin(t * 10.9 + 2.9)) ** 2 + 0.3 * eb;
  p.ember1.scale.setScalar(e1);
  p.ember2.scale.setScalar(e2);
  p.ember1.position.y = 0.12 + 0.025 * Math.sin(t * 5.1);
  p.ember2.position.y = 0.22 + 0.03 * Math.sin(t * 6.7 + 1.4);
}

export const skills: SkillDef[] = [
  {
    id: 'emberfox.flame-dart',
    nameKey: 'skill.emberfox.flame-dart.name',
    descriptionKey: 'skill.emberfox.flame-dart.desc',
    element: 'fire',
    targeting: 'projectile',
    cost: 6,
    cooldown: 1.8,
    power: 12,
    range: 18,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'emberfox.ember-pounce',
    nameKey: 'skill.emberfox.ember-pounce.name',
    descriptionKey: 'skill.emberfox.ember-pounce.desc',
    element: 'fire',
    targeting: 'melee',
    cost: 10,
    cooldown: 3.5,
    power: 19,
    range: 2.6,
    learnAtLevel: 5,
    castAnim: 'attack',
  },
  {
    id: 'emberfox.tail-flare',
    nameKey: 'skill.emberfox.tail-flare.name',
    descriptionKey: 'skill.emberfox.tail-flare.desc',
    element: 'fire',
    targeting: 'aoe',
    cost: 15,
    cooldown: 7,
    power: 26,
    range: 4.5,
    storePrice: 190,
    castAnim: 'special',
  },
  {
    id: 'emberfox.foxfire-beam',
    nameKey: 'skill.emberfox.foxfire-beam.name',
    descriptionKey: 'skill.emberfox.foxfire-beam.desc',
    element: 'fire',
    targeting: 'beam',
    cost: 22,
    cooldown: 10,
    power: 36,
    range: 14,
    storePrice: 360,
    castAnim: 'cast',
  },
];

export const species: PalSpecies = {
  id: 'emberfox',
  nameKey: 'pal.emberfox.name',
  element: 'fire',
  locomotion: 'ground',
  descriptionKey: 'pal.emberfox.desc',
  baseStats: { maxHp: 46, attack: 12, defense: 6, speed: 5.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
