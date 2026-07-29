import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';

// ---------------------------------------------------------------------------
// Boulderpup — a puppy golem of stacked granite strata. Rock element, ground.
// Voxel scale 0.1: ~0.85 tall at the ear tips, chunky and heavy.
// ---------------------------------------------------------------------------

// Palette
const G1 = 0xaba396;      // light granite (brightened: the old top course sat
                          // too close to the mid tone, so the whole creature
                          // read as one flat lump under any lighting)
const STONE = 0x8f9096;   // cool grey slab — material contrast vs warm granite
const G2 = 0x7d746a;      // mid granite
const G3 = 0x655d54;      // dark granite
const BR = 0x8a7357;      // warm brown stratum
const MOSS = 0x6cb04b;    // bright moss
const MOSS2 = 0x568f3a;   // deep moss
const CRYS = 0xffb733;    // amber crystal
const CRYS2 = 0xd98f1f;   // amber crystal base
const NOSE = 0x453f38;    // stone nose

const BODY_Y = 0.30;
const HEAD_X = 0, HEAD_Y = 0.28, HEAD_Z = 0.24;
const LEG_Y = 0.30;
const TAIL_UP = 0.35;
const EAR_TILT = 0.18;

type Parts = Record<string, THREE.Object3D>;

const s01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => { const x = s01(t); return x * x * (3 - 2 * x); };
const decay = (t: number, r: number): number => Math.exp(-r * Math.max(0, t));
/** Eased 0 -> 1 -> 0 bump inside [a, b] */
function bump(t: number, a: number, b: number, riseFrac = 0.4): number {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return u < riseFrac ? smooth(u / riseFrac) : smooth((1 - u) / (1 - riseFrac));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export const skills: SkillDef[] = [
  {
    id: 'boulderpup.pebble-pop',
    name: 'Pebble Pop',
    description: 'Sneezes a hot pebble at surprising velocity. Bless you.',
    element: 'rock', targeting: 'projectile',
    cost: 5, cooldown: 1.5, power: 9, range: 14,
    learnAtLevel: 1, castAnim: 'attack',
  },
  {
    id: 'boulderpup.stomp-quake',
    name: 'Stomp Quake',
    description: 'Slams all four paws down at once; the ground complains loudly.',
    element: 'rock', targeting: 'aoe',
    cost: 13, cooldown: 5.5, power: 21, range: 5,
    learnAtLevel: 4, castAnim: 'cast',
  },
  {
    id: 'boulderpup.moss-mantle',
    name: 'Moss Mantle',
    description: 'Fluffs up its back-moss into a springy cushion that soaks up scrapes.',
    element: 'grass', targeting: 'self',
    cost: 12, cooldown: 8, power: 16, range: 0,
    storePrice: 160, castAnim: 'cast',
  },
  {
    id: 'boulderpup.amber-avalanche',
    name: 'Amber Avalanche',
    description: 'The back-crystal flares white-hot and hurls a fan of molten amber boulders.',
    element: 'rock', targeting: 'aoe',
    cost: 24, cooldown: 12, power: 44, range: 7,
    storePrice: 380, castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------
function buildLeg(kind: 'FL' | 'FR' | 'BL' | 'BR'): THREE.Mesh {
  const m = new VoxelModel();
  // Mismatched quarried-stone legs: same height, different bulk and strata.
  if (kind === 'FL') {
    m.box(0, 0, 0, 1, 2, 1, G2);
    m.box(0, 0, 0, 1, 0, 1, G3);
  } else if (kind === 'FR') {
    m.box(0, 0, 0, 1, 2, 1, G1);
    m.box(0, 1, 0, 1, 1, 1, BR);
    m.set(1, 2, 1, MOSS2);
  } else if (kind === 'BL') {
    m.box(0, 0, 0, 2, 2, 1, G3);
    m.box(0, 0, 0, 2, 0, 1, G2);
    m.set(0, 2, 0, MOSS);
  } else {
    m.box(0, 0, 0, 1, 2, 2, BR);
    m.box(0, 0, 0, 1, 0, 2, G3);
  }
  // stubby toes
  m.set(0, 0, 2, G3);
  m.set(1, 0, 2, G3);
  const mesh = m.build(0.1, true);
  mesh.position.set(0, -LEG_Y, 0.02);
  return mesh;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  // --- torso: stacked strata with moss patches ---------------------------
  const torso = new VoxelModel();
  torso.box(-2, 0, -3, 2, 0, 2, G3);       // inset belly course
  torso.box(-3, 1, -4, 3, 1, 3, G2);
  torso.box(-3, 2, -4, 3, 2, 3, BR);       // warm brown stratum
  torso.box(-3, 3, -4, 3, 3, 3, G1);
  torso.box(-2, 4, -3, 2, 4, 2, G1);       // domed top course (catches the sun)
  // Cool grey slate plates across the back and shoulders: the warm-granite-only
  // body had no material story, so it read as chocolate rather than rock.
  torso.box(-2, 4, -1, 1, 4, 1, STONE);
  torso.set(2, 3, -3, STONE); torso.set(-2, 3, -3, STONE);
  torso.box(-3, 3, 1, -3, 3, 2, STONE);
  // moss patches (top and flanks)
  torso.set(-1, 4, -2, MOSS); torso.set(0, 4, -2, MOSS); torso.set(1, 4, -2, MOSS2);
  torso.set(2, 4, 1, MOSS2); torso.set(2, 4, 2, MOSS);
  torso.set(3, 2, 0, MOSS); torso.set(3, 2, 1, MOSS2); torso.set(3, 1, 0, MOSS2);
  torso.set(-3, 3, -2, MOSS2); torso.set(-3, 3, -1, MOSS);
  // chipped corners
  torso.set(3, 1, -4, G3); torso.set(-3, 1, 3, G3); torso.set(-3, 2, -4, G3);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.06, 0);
  body.add(torsoMesh);

  // --- glowing amber crystal on the back ---------------------------------
  const crystal = new THREE.Group();
  crystal.position.set(0, 0.40, -0.14);
  crystal.rotation.z = 0.12;
  body.add(crystal);
  const crys = new VoxelModel();
  crys.set(0, 0, 0, CRYS); crys.set(1, 0, 0, CRYS2); crys.set(-1, 0, 0, CRYS2);
  crys.set(0, 0, 1, CRYS2); crys.set(0, 0, -1, CRYS2);
  crys.set(0, 1, 0, CRYS);
  crys.set(0, 2, 0, CRYS);
  const crystalCore = crys.build(0.1, true);
  const crysMat = crystalCore.material as THREE.MeshStandardMaterial;
  crysMat.emissive = new THREE.Color(0xff9d20);
  crysMat.emissiveIntensity = 0.9;
  crysMat.roughness = 0.35;
  crystal.add(crystalCore);

  // --- heavy square head with deep-set glowing eyes ----------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  const head = new VoxelModel();
  head.box(-3, 0, 0, 3, 0, 4, G2);
  head.box(-3, 1, 0, 3, 1, 4, G1);
  // eye row: leave (±2, 2, 4) empty -> deep sockets
  head.box(-3, 2, 0, 3, 2, 3, G1);
  head.box(-3, 2, 4, -3, 2, 4, G1);
  head.box(-1, 2, 4, 1, 2, 4, G1);
  head.box(3, 2, 4, 3, 2, 4, G1);
  head.box(-3, 3, 0, 3, 3, 4, G3);         // dark cap course
  head.set(-2, 3, 5, G3); head.set(2, 3, 5, G3); // heavy brow ledges
  head.box(-2, 0, 5, 2, 1, 5, BR);         // chunky muzzle
  head.set(0, 1, 6, NOSE);                 // stone nose
  head.set(-3, 1, 2, MOSS2);               // cheek moss
  head.set(1, 3, 1, MOSS);                 // crown moss tuft
  const headMesh = head.build(0.1, true);
  headMesh.position.set(0, -0.20, 0.06);
  headGroup.add(headMesh);

  // deep-set glowing amber eyes (recessed emissive cubes inside the sockets)
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x1c1712, emissive: new THREE.Color(0xffb833), emissiveIntensity: 1.8,
    roughness: 0.4, metalness: 0,
  });
  const eyeGeo = new THREE.BoxGeometry(0.08, 0.075, 0.06);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.2, 0.05, 0.16);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.2, 0.05, 0.16);
  headGroup.add(eyeL, eyeR);

  // --- slab ears ---------------------------------------------------------
  const mkEar = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.20, 0.16, 0.02);
    g.rotation.set(-0.1, 0, -sign * EAR_TILT);
    const ear = new VoxelModel();
    ear.box(0, 0, 0, 1, 1, 0, G3);
    ear.set(sign > 0 ? 0 : 1, 0, 0, G2);
    const mesh = ear.build(0.1, true);
    mesh.position.y = -0.02;
    g.add(mesh);
    headGroup.add(g);
    return g;
  };
  const earR = mkEar(1);
  const earL = mkEar(-1);

  // --- stubby stone tail -------------------------------------------------
  const tailGroup = new THREE.Group();
  tailGroup.position.set(0, 0.06, -0.40);
  tailGroup.rotation.x = TAIL_UP;
  body.add(tailGroup);
  const tail = new VoxelModel();
  tail.box(-1, 0, -2, 1, 1, 0, G2);
  tail.box(-1, 0, -2, 1, 0, -2, G3);
  tail.set(0, 1, -2, MOSS2);
  const tailMesh = tail.build(0.1, true);
  tailMesh.position.set(0, -0.05, -0.14);
  tailGroup.add(tailMesh);

  // --- chunky mismatched legs (children of root so body can settle) ------
  const mkLegGroup = (kind: 'FL' | 'FR' | 'BL' | 'BR', x: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, LEG_Y, z);
    g.add(buildLeg(kind));
    root.add(g);
    return g;
  };
  const legFL = mkLegGroup('FL', -0.20, 0.24);
  const legFR = mkLegGroup('FR', 0.20, 0.24);
  const legBL = mkLegGroup('BL', -0.21, -0.26);
  const legBR = mkLegGroup('BR', 0.21, -0.26);

  return {
    root,
    parts: {
      body, head: headGroup, earL, earR, tail: tailGroup,
      crystal, crystalCore, eyeL, eyeR,
      legFL, legFR, legBL, legBR,
    },
    height: 0.85,
    radius: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
function setEyes(P: Parts, intensity: number, squint: number): void {
  const mat = (P.eyeL as THREE.Mesh).material as THREE.MeshStandardMaterial; // shared with eyeR
  mat.emissiveIntensity = intensity;
  P.eyeL.scale.set(1, 1 - squint, 1);
  P.eyeR.scale.set(1, 1 - squint, 1);
}

function setCrystal(P: Parts, intensity: number, scale: number, tilt: number): void {
  const mat = (P.crystalCore as THREE.Mesh).material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = intensity;
  P.crystal.scale.set(scale, scale, scale);
  P.crystal.rotation.z = 0.12 + tilt;
}

/** Heavy trot: diagonal leg pairs, sharp footfall weight, body settle. */
function stompGait(P: Parts, ph: number, amp: number, bob: number): void {
  const a = Math.sin(ph);
  const b = Math.sin(ph + Math.PI);
  P.legFL.rotation.x = amp * a;
  P.legBR.rotation.x = amp * a * 0.9;
  P.legFR.rotation.x = amp * b;
  P.legBL.rotation.x = amp * b * 0.9;
  const lift = Math.pow(Math.abs(a), 0.8);
  const impact = Math.pow(Math.abs(Math.cos(ph)), 12); // spikes at each footfall
  P.body.position.y = BODY_Y + bob * lift - 0.022 * impact;
  P.body.scale.set(1 + 0.05 * impact, 1 - 0.10 * impact, 1 + 0.05 * impact);
  P.body.rotation.set(0.03 * Math.sin(ph * 2 + 0.6), 0, 0.05 * a);
  P.head.rotation.set(0.06 * Math.sin(ph * 2 - 0.8), 0, -0.04 * a);
  P.head.position.y = HEAD_Y - 0.02 * impact;
  P.earL.rotation.x = -0.1 + 0.25 * Math.sin(ph * 2 - 1.3);
  P.earR.rotation.x = -0.1 + 0.25 * Math.sin(ph * 2 - 1.5);
  P.tail.rotation.x = TAIL_UP + 0.15 * impact;
  P.crystal.rotation.z = 0.12 + 0.06 * Math.sin(ph * 2 - 1.0);
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const P = rig.parts;
  const t = ctx.time, at = ctx.actionTime, ms = ctx.moveSpeed;

  // Absolute base pose every frame.
  P.body.position.set(0, BODY_Y, 0);
  P.body.rotation.set(0, 0, 0);
  P.body.scale.set(1, 1, 1);
  P.head.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  P.head.rotation.set(0, 0, 0);
  P.earL.rotation.set(-0.1, 0, EAR_TILT);
  P.earR.rotation.set(-0.1, 0, -EAR_TILT);
  P.tail.rotation.set(TAIL_UP, 0, 0);
  P.legFL.rotation.set(0, 0, 0);
  P.legFR.rotation.set(0, 0, 0);
  P.legBL.rotation.set(0, 0, 0);
  P.legBR.rotation.set(0, 0, 0);

  // periodic sleepy blink of the glowing eyes
  const blink = Math.pow(Math.max(0, Math.sin(t * 0.61 + 2.0)), 80);

  switch (ctx.action) {
    case 'idle': {
      const br = Math.sin(t * 2.0);
      P.body.scale.set(1 - 0.008 * br, 1 + 0.02 * br, 1 - 0.008 * br);
      P.head.rotation.set(
        0.03 * Math.sin(t * 2.0 + 0.8),
        0.14 * Math.tanh(2.0 * Math.sin(t * 0.31)),  // slow curious look-around
        0.07 * Math.sin(t * 0.5));
      const twitch = Math.pow(Math.max(0, Math.sin(t * 0.9 + 2.0)), 40);
      P.earL.rotation.x = -0.1 - 0.4 * twitch + 0.02 * br;
      P.earR.rotation.x = -0.1 + 0.02 * Math.sin(t * 2.0 + 1.0);
      P.tail.rotation.y = 0.12 * Math.sin(t * 1.1);
      P.legFL.rotation.x = 0.02 * Math.sin(t * 2.0);
      P.legFR.rotation.x = 0.02 * Math.sin(t * 2.0 + 1.5);
      P.legBL.rotation.x = 0.015 * Math.sin(t * 2.0 + 3.0);
      P.legBR.rotation.x = 0.015 * Math.sin(t * 2.0 + 4.5);
      setCrystal(P, 0.85 + 0.25 * Math.sin(t * 1.7), 1 + 0.03 * Math.sin(t * 1.7), 0);
      setEyes(P, 1.8, 0.8 * blink);
      break;
    }

    case 'walk': {
      stompGait(P, t * 5.5, 0.5, 0.035);
      P.tail.rotation.y = Math.tanh(Math.sin(t * 4) * 2) * 0.25; // stiff stone wag
      setCrystal(P, 0.9 + 0.2 * Math.abs(Math.sin(t * 5.5)), 1, 0.06 * Math.sin(t * 11 - 1));
      setEyes(P, 1.8, 0.8 * blink);
      break;
    }

    case 'run':
    case 'fly': {
      stompGait(P, t * 8.5, 0.75, 0.05);
      P.body.rotation.x += 0.10 + 0.04 * ms; // eager forward lean
      P.head.rotation.x -= 0.08;
      P.tail.rotation.y = Math.tanh(Math.sin(t * 6) * 2) * 0.2;
      P.earL.rotation.x -= 0.25; // ears pinned by speed
      P.earR.rotation.x -= 0.25;
      setCrystal(P, 1.1 + 0.3 * Math.abs(Math.sin(t * 8.5)), 1, 0.08 * Math.sin(t * 17 - 1));
      setEyes(P, 2.0, 0.3);
      break;
    }

    case 'swim': {
      // Determined doggy paddle: nose up, legs churning.
      const ph = t * 7.0;
      P.body.rotation.set(-0.25, 0, 0.05 * Math.sin(ph * 0.5));
      P.body.position.y = BODY_Y + 0.03 * Math.sin(ph * 0.5);
      P.head.rotation.set(-0.2, 0.08 * Math.sin(t * 1.2), 0);
      P.legFL.rotation.x = 0.7 * Math.sin(ph);
      P.legFR.rotation.x = 0.7 * Math.sin(ph + Math.PI);
      P.legBL.rotation.x = 0.5 * Math.sin(ph + Math.PI * 0.5);
      P.legBR.rotation.x = 0.5 * Math.sin(ph + Math.PI * 1.5);
      P.earL.rotation.x = -0.4;
      P.earR.rotation.x = -0.4;
      P.tail.rotation.set(TAIL_UP + 0.15, 0.2 * Math.sin(ph), 0);
      setCrystal(P, 0.9, 1, 0.04 * Math.sin(ph));
      setEyes(P, 1.8, 0.2);
      break;
    }

    case 'attack': {
      // Crouch back, then a granite headbutt lunge.
      const wind = bump(at, 0.0, 0.26, 0.6);
      const lunge = bump(at, 0.14, 0.5, 0.3);
      P.body.position.y = BODY_Y - 0.05 * wind + 0.02 * lunge;
      P.body.position.z = -0.06 * wind + 0.15 * lunge;
      P.body.rotation.x = -0.14 * wind + 0.24 * lunge;
      P.body.scale.set(1 + 0.04 * wind, 1 - 0.06 * wind + 0.04 * lunge, 1 + 0.04 * wind);
      P.head.rotation.x = -0.3 * wind + 0.55 * lunge;
      P.head.position.z = HEAD_Z + 0.08 * lunge;
      P.earL.rotation.x = -0.1 - 0.5 * lunge;
      P.earR.rotation.x = -0.1 - 0.5 * lunge;
      P.tail.rotation.x = TAIL_UP + 0.3 * wind;
      P.legFL.rotation.x = 0.35 * wind - 0.5 * lunge;
      P.legFR.rotation.x = 0.35 * wind - 0.5 * lunge;
      P.legBL.rotation.x = -0.2 * wind + 0.45 * lunge;
      P.legBR.rotation.x = -0.2 * wind + 0.45 * lunge;
      setCrystal(P, 0.9 + 1.6 * lunge, 1 + 0.1 * lunge, 0);
      setEyes(P, 1.8 + 1.4 * lunge, 0.25 * lunge);
      break;
    }

    case 'cast': {
      // Rears up on hind legs, front paws pedaling, crystal blazing.
      const rear = smooth(at / 0.45);
      P.body.rotation.x = -0.5 * rear;
      P.body.position.y = BODY_Y + 0.06 * rear;
      P.body.position.z = -0.04 * rear;
      P.head.rotation.x = 0.3 * rear + 0.04 * Math.sin(t * 5);
      P.legFL.rotation.x = -0.95 * rear + 0.12 * Math.sin(t * 7) * rear;
      P.legFR.rotation.x = -0.95 * rear + 0.12 * Math.sin(t * 7 + Math.PI) * rear;
      P.legBL.rotation.x = 0.35 * rear;
      P.legBR.rotation.x = 0.35 * rear;
      P.earL.rotation.x = -0.1 + 0.25 * rear;
      P.earR.rotation.x = -0.1 + 0.25 * rear;
      P.tail.rotation.set(TAIL_UP - 0.15 * rear, 0.1 * Math.sin(t * 6) * rear, 0);
      setCrystal(P,
        0.9 + 2.2 * rear + 0.6 * Math.sin(t * 10) * rear,
        1 + 0.22 * rear + 0.05 * Math.sin(t * 10) * rear,
        0.05 * Math.sin(t * 10) * rear);
      setEyes(P, 1.8 + 1.8 * rear, 0);
      break;
    }

    case 'special': {
      // Gather low, leap, and slam down with a crystal super-flare.
      const gather = bump(at, 0, 0.34, 0.7);
      const leap = Math.sin(Math.PI * s01((at - 0.30) / 0.30));
      const land = at > 0.60 ? decay(at - 0.60, 7) : 0;
      const shake = Math.sin(at * 60) * land;
      P.body.position.y = BODY_Y - 0.08 * gather + 0.26 * leap - 0.05 * land;
      P.body.position.x = 0.02 * shake;
      P.body.scale.set(
        1 + 0.07 * gather + 0.08 * land, 1 - 0.14 * gather + 0.14 * leap - 0.16 * land,
        1 + 0.07 * gather + 0.08 * land);
      P.body.rotation.x = 0.1 * gather - 0.18 * leap;
      P.head.rotation.x = -0.2 * gather + 0.15 * leap + 0.1 * land;
      P.earL.rotation.x = -0.1 - 0.35 * leap - 0.3 * land;
      P.earR.rotation.x = -0.1 - 0.35 * leap - 0.3 * land;
      P.tail.rotation.x = TAIL_UP + 0.35 * leap + 0.2 * land;
      P.tail.rotation.y = 0.1 * shake;
      const splay = 0.45 * leap + 0.3 * land;
      P.legFL.rotation.x = 0.3 * gather - splay;
      P.legFR.rotation.x = 0.3 * gather - splay;
      P.legBL.rotation.x = 0.3 * gather + splay * 0.7;
      P.legBR.rotation.x = 0.3 * gather + splay * 0.7;
      setCrystal(P, 0.9 + 1.2 * gather + 3.0 * (leap + land) * 0.8,
        1 + 0.1 * gather + 0.3 * leap + 0.15 * land, 0.1 * shake);
      setEyes(P, 2.2 + 1.6 * leap, 0);
      break;
    }

    case 'hurt': {
      const sh = decay(at, 5.5);
      const jit = Math.sin(at * 42);
      P.body.position.set(0.03 * jit * sh, BODY_Y - 0.02 * sh, -0.06 * sh);
      P.body.rotation.set(-0.1 * sh, 0, 0.06 * jit * sh);
      P.head.rotation.set(-0.12 * sh, 0.2 * Math.sin(at * 30) * sh, 0.15 * jit * sh);
      P.earL.rotation.x = -0.1 - 0.6 * sh;
      P.earR.rotation.x = -0.1 - 0.6 * sh;
      P.tail.rotation.x = TAIL_UP - 0.4 * sh;
      P.legFL.rotation.x = 0.15 * sh;
      P.legFR.rotation.x = -0.15 * sh;
      P.legBL.rotation.x = -0.1 * sh;
      P.legBR.rotation.x = 0.1 * sh;
      setCrystal(P, 0.4 + 0.3 * Math.abs(jit) * sh, 1 - 0.05 * sh, 0.08 * jit * sh);
      setEyes(P, 1.8 * (0.4 + 0.6 * Math.abs(Math.sin(at * 25))), 0.4 * sh);
      break;
    }

    case 'happy': {
      // Overjoyed granite bouncing with a furious stiff tail-wag.
      const ph = at * 8;
      const b = Math.abs(Math.sin(ph));
      const land = 1 - b;
      P.body.position.y = BODY_Y + 0.09 * b;
      P.body.scale.set(1 + 0.05 * land, 1 - 0.10 * land * land, 1 + 0.05 * land);
      P.body.rotation.set(-0.06 * b, 0.15 * Math.sin(at * 4), 0.04 * Math.sin(ph));
      P.head.rotation.set(-0.12 * b, 0.2 * Math.sin(at * 2.5), 0.3 * Math.sin(at * 4));
      P.earL.rotation.x = -0.1 + 0.35 * Math.sin(ph * 2 - 0.9);
      P.earR.rotation.x = -0.1 + 0.35 * Math.sin(ph * 2 - 1.2);
      P.tail.rotation.x = TAIL_UP + 0.15 * b;
      P.tail.rotation.y = Math.tanh(Math.sin(at * 14) * 2.5) * 0.35;
      P.legFL.rotation.x = -0.35 * b;
      P.legFR.rotation.x = -0.35 * Math.abs(Math.sin(ph + Math.PI * 0.5));
      P.legBL.rotation.x = 0.15 * b;
      P.legBR.rotation.x = 0.15 * b;
      setCrystal(P, 1.2 + 0.8 * Math.abs(Math.sin(at * 10)), 1 + 0.06 * b, 0.05 * Math.sin(at * 10));
      setEyes(P, 2.2, 0.45); // happy squint
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'boulderpup',
  name: 'Boulderpup',
  element: 'rock',
  locomotion: 'ground',
  description:
    'A puppy chiseled from mountain strata by a very sentimental earthquake. '
    + 'Moss grows where it naps too long, and the amber crystal on its back '
    + 'glows brighter the happier it gets.',
  baseStats: { maxHp: 64, attack: 11, defense: 16, speed: 4.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
