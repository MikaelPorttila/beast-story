import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';

// ---------------------------------------------------------------------------
// Emberfox — a small, eager fire fox with a magnificent flame-tipped tail.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette
const ORANGE = 0xf3712b;   // ember-orange coat
const RUSSET = 0xcc4e14;   // deeper saddle along the back
const CREAM = 0xffe9c4;    // chest / muzzle / belly
const SOCK = 0x54322b;     // dark socks, ear tips, brows
const NOSE = 0x33201c;
const EYE_WHITE = 0xffffff;
const PUPIL = 0x2a1b18;
const EAR_PINK = 0xf2a38e;
const FLAME_OUT = 0xffae33; // tail-tip outer flame
const FLAME_MID = 0xffc93f;
const FLAME_CORE = 0xffe066;
const FLAME_HOT = 0xfff3a6;

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

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.8, 0, 2.6, 1.9, 3.8, ORANGE);
  m.ellipsoid(0, 0.4, 0, 2.1, 1.1, 3.2, CREAM);      // belly
  m.ellipsoid(0, 2.8, -0.5, 2.1, 1.2, 2.9, RUSSET);  // saddle
  m.ellipsoid(0, 1.4, 2.8, 1.8, 1.6, 1.4, CREAM);    // fluffy chest ruff
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.8, 0.4, 2.4, 2.0, 2.2, ORANGE);
  // Cream stays low on the snout — when it climbed to the eye line the whole
  // face read as one pale band with two dark holes (bandit mask).
  m.ellipsoid(0, 0.6, 1.9, 1.7, 0.9, 1.2, CREAM);    // lower cheeks
  m.box(-1, 1, 3, 1, 1, 4, CREAM);                    // muzzle
  m.set(0, 2, 4, NOSE);                               // nose
  // Flat coat-colored cheek plates so the eyes sit on a face, not in mid-air.
  m.box(1, 2, 2, 3, 3, 2, ORANGE);
  m.box(-3, 2, 2, -1, 3, 2, ORANGE);
  // Eyes: 2x2 sclera with the pupil filling the inner column, and an orange
  // bridge voxel between them so the two eyes never merge into one band.
  for (const sx of [1, -1]) {
    m.set(sx * 3, 3, 3, EYE_WHITE);
    m.set(sx * 3, 2, 3, EYE_WHITE);
    m.set(sx * 2, 3, 3, PUPIL);
    m.set(sx * 2, 2, 3, PUPIL);
    m.set(sx * 1, 3, 3, ORANGE);
    m.set(sx * 1, 2, 3, ORANGE);
  }
  return m.build(S, true);
}

function makeEar(tipX: number, innerX: number): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 1, 0, ORANGE);
  m.set(tipX, 2, 0, SOCK);         // dark pointed tip
  m.set(innerX, 0, 1, EAR_PINK);   // pink inner-ear voxel facing forward
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
  // The flame glows for real: gradient brightens toward the tip.
  m.markEmissive(FLAME_OUT, 1.2);
  m.markEmissive(FLAME_MID, 1.4);
  m.markEmissive(FLAME_CORE, 1.6);
  m.markEmissive(FLAME_HOT, 1.8);
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
  m.markEmissive(FLAME_MID, 1.4);
  m.markEmissive(FLAME_CORE, 1.6);
  m.markEmissive(FLAME_HOT, 1.8);
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
  headMesh.position.set(0, -0.16, 0.06);
  head.add(headMesh);

  const earL = new THREE.Group();
  earL.position.set(0.15, 0.26, -0.05);
  earL.rotation.z = -EAR_Z;
  head.add(earL);
  const earLMesh = makeEar(1, 0);
  earLMesh.position.set(0, -0.02, 0);
  earL.add(earLMesh);

  const earR = new THREE.Group();
  earR.position.set(-0.15, 0.26, -0.05);
  earR.rotation.z = EAR_Z;
  head.add(earR);
  const earRMesh = makeEar(0, 1);
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

  // Fake bloom: soft warm-orange halo on the flame tip (no postprocessing
  // pass exists). Parented to tailTip — not flame — so the flame's non-uniform
  // flicker scaling never distorts the billboard; it still rides the tail.
  const flameGlow = makeGlowSprite(0xffb347, 0.38, 0.26);
  flameGlow.position.set(0, 0.1, -0.28);
  tailTip.add(flameGlow);

  // Two tiny ember motes that flicker just off the flame.
  const ember1 = new THREE.Group();
  ember1.position.set(0.13, 0.12, -0.34);
  tailTip.add(ember1);
  ember1.add(makeEmber(FLAME_CORE, 1.6));

  const ember2 = new THREE.Group();
  ember2.position.set(-0.11, 0.22, -0.2);
  tailTip.add(ember2);
  ember2.add(makeEmber(FLAME_HOT, 1.8));

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
      const wave = t * 1.7;
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
      const f = isRun ? 8.5 + 3.5 * ms : 5.5 + 2.5 * ms;
      const ph = t * f;
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
      // tail streams behind and whips with the gait
      const wave = ph * 0.9;
      tbx = TAIL_BASE_X - 0.3 * ms * (isRun ? 1 : 0.5);
      tmx = TAIL_MID_X - 0.1 * ms;
      ttx = TAIL_TIP_X + 0.05 * Math.sin(ph * 2);
      tby = 0.25 * Math.sin(wave);
      tmy = 0.35 * Math.sin(wave - 0.9);
      tty = 0.45 * Math.sin(wave - 1.8);
      break;
    }
    case 'swim': { // doggy paddle, nose proudly above water
      const ph = t * 7;
      brx = -0.22;
      bpy += 0.02 * Math.sin(t * 2.3);
      hrx = -0.25;
      flrx = 0.7 + 0.5 * Math.sin(ph);
      frrx = 0.7 + 0.5 * Math.sin(ph + Math.PI);
      blrx = 0.5 + 0.4 * Math.sin(ph + 1.5);
      brrx = 0.5 + 0.4 * Math.sin(ph + 1.5 + Math.PI);
      tbx = 0.15;
      tby = 0.4 * Math.sin(t * 3);
      tmy = 0.5 * Math.sin(t * 3 - 1);
      tty = 0.6 * Math.sin(t * 3 - 2);
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
    name: 'Flame Dart',
    description: 'Spits a zippy bolt of foxfire that pops in a shower of sparks.',
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
    name: 'Ember Pounce',
    description: 'A gleeful flaming pounce — equal parts play and ambush.',
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
    name: 'Tail Flare',
    description: 'Whirls its magnificent tail into a ring of cinders that singes everything nearby.',
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
    name: 'Foxfire Beam',
    description: 'Rears up and exhales a roaring ribbon of blue-white foxfire.',
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
  name: 'Emberfox',
  element: 'fire',
  locomotion: 'ground',
  description:
    'An eager little fox whose oversized tail smolders when it is excited — which is always.',
  baseStats: { maxHp: 46, attack: 12, defense: 6, speed: 5.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
