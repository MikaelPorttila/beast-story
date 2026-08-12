import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";

// Boulderpup — puppy golem of stacked granite strata. Voxel scale 0.1, ~0.85 tall.
// Every stone tone is warm: the only light on a shaded face is blue sky bounce, so a
// neutral grey renders BLUE. What matters is RANGE, not average — 0.38:0.90 relative
// luminance, with G3 and BR carrying the shadow tone and the one dark stratum band.
const G1 = 0xdfc9a0;
const G0 = 0xf5e9cd;
const STONE = 0xd0c9b6;
const G2 = 0xd3b994;
const G3 = 0x94795c;
const BR = 0x7a6047;
const MOSS = 0x7ecc57;
const MOSS2 = 0x5fa33e;
const CRYS = 0xffb733;
const CRYS2 = 0xd98f1f;
const NOSE = 0x4a423a;
const EYE_IRIS = 0x36291d;
const EYE_HOT = 0xfff0cf;
// 0.2: bloom amplifies it and the socket is one cell — at 0.32 the irises rendered as
// two red-hot squares. The catchlight stays plain paint, per eyes2x2.
const EYE_GLOW = 0.2;

const BODY_Y = 0.3;
const HEAD_X = 0,
  HEAD_Y = 0.28,
  HEAD_Z = 0.24;
const LEG_Y = 0.3;
const TAIL_UP = 0.35;
const EAR_TILT = 0.18;

type Parts = Record<string, THREE.Object3D>;

const s01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => {
  const x = s01(t);
  return x * x * (3 - 2 * x);
};
const decay = (t: number, r: number): number => Math.exp(-r * Math.max(0, t));
/** Eased 0 -> 1 -> 0 bump inside [a, b] */
function bump(t: number, a: number, b: number, riseFrac = 0.4): number {
  if (t <= a || t >= b) {
    return 0;
  }
  const u = (t - a) / (b - a);
  return u < riseFrac ? smooth(u / riseFrac) : smooth((1 - u) / (1 - riseFrac));
}

export const skills: SkillDef[] = [
  {
    id: "boulderpup.pebble-pop",
    nameKey: "skill.boulderpup.pebble-pop.name",
    descriptionKey: "skill.boulderpup.pebble-pop.desc",
    element: "rock",
    targeting: "projectile",
    cost: 5,
    cooldown: 1.5,
    power: 9,
    range: 14,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "boulderpup.stomp-quake",
    nameKey: "skill.boulderpup.stomp-quake.name",
    descriptionKey: "skill.boulderpup.stomp-quake.desc",
    element: "rock",
    targeting: "aoe",
    cost: 13,
    cooldown: 5.5,
    power: 21,
    range: 5,
    learnAtLevel: 4,
    castAnim: "cast",
  },
  {
    id: "boulderpup.moss-mantle",
    nameKey: "skill.boulderpup.moss-mantle.name",
    descriptionKey: "skill.boulderpup.moss-mantle.desc",
    element: "grass",
    targeting: "self",
    cost: 12,
    cooldown: 8,
    power: 16,
    range: 0,
    storePrice: 160,
    castAnim: "cast",
  },
  {
    id: "boulderpup.amber-avalanche",
    nameKey: "skill.boulderpup.amber-avalanche.name",
    descriptionKey: "skill.boulderpup.amber-avalanche.desc",
    element: "rock",
    targeting: "aoe",
    cost: 24,
    cooldown: 12,
    power: 44,
    range: 7,
    storePrice: 380,
    castAnim: "special",
  },
];

function buildLeg(kind: "FL" | "FR" | "BL" | "BR"): THREE.Mesh {
  const m = new VoxelModel();
  // Mismatched quarried legs: same height, different bulk and strata.
  if (kind === "FL") {
    m.box(0, 0, 0, 1, 2, 1, G2);
    m.box(0, 0, 0, 1, 0, 1, G3);
  } else if (kind === "FR") {
    m.box(0, 0, 0, 1, 2, 1, G1);
    m.box(0, 1, 0, 1, 1, 1, BR);
  } else if (kind === "BL") {
    m.box(0, 0, 0, 2, 2, 1, G3);
    m.box(0, 0, 0, 2, 0, 1, G2);
  } else {
    m.box(0, 0, 0, 1, 2, 2, BR);
    m.box(0, 0, 0, 1, 0, 2, G3);
  }
  m.set(0, 0, 2, G3);
  m.set(1, 0, 2, G3);
  const mesh = m.build(0.1, true);
  mesh.position.set(0, -LEG_Y, 0.02);
  return mesh;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = new VoxelModel();
  torso.box(-2, 0, -3, 2, 0, 2, G3);
  torso.box(-3, 1, -4, 3, 1, 3, G2);
  torso.box(-3, 2, -4, 3, 2, 3, BR);
  torso.box(-3, 3, -4, 3, 3, 3, G1);
  torso.box(-2, 4, -3, 2, 4, 2, G1);
  torso.box(-2, 4, -1, 1, 4, 1, STONE);
  torso.set(2, 3, -3, STONE);
  torso.set(-2, 3, -3, STONE);
  torso.box(-3, 3, 1, -3, 3, 2, STONE);
  // Moss only on the top course (y = 4): on a vertical granite face a lone green cell
  // reads as a material error, not lichen.
  torso.set(-1, 4, -2, MOSS);
  torso.set(0, 4, -2, MOSS2);
  torso.set(1, 4, -2, MOSS);
  torso.set(2, 4, 1, MOSS2);
  torso.set(-2, 4, 2, MOSS);
  torso.set(0, 4, 0, MOSS2);
  torso.set(-1, 4, 1, MOSS);
  torso.set(3, 1, -4, G3);
  torso.set(-3, 1, 3, G3);
  torso.set(-3, 2, -4, G3);
  rimTop(torso, G0, -3, 3, 0, 4, -4, 3);
  shadeUnder(torso, G3, -3, 3, 0, 4, -4, 3);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.06, 0);
  body.add(torsoMesh);

  const crystal = new THREE.Group();
  // On the rump, not above the skull, where it photographed as a pilot light.
  crystal.position.set(0, 0.3, -0.34);
  crystal.rotation.z = 0.12;
  body.add(crystal);
  const crys = new VoxelModel();
  crys.set(0, 0, 0, CRYS);
  crys.set(1, 0, 0, CRYS2);
  crys.set(-1, 0, 0, CRYS2);
  crys.set(0, 0, 1, CRYS2);
  crys.set(0, 0, -1, CRYS2);
  crys.set(0, 1, 0, CRYS);
  crys.set(0, 2, 0, CRYS);
  const crystalCore = crys.build(0.1, true);
  const crysMat = crystalCore.material as THREE.MeshStandardMaterial;
  crysMat.emissive = new THREE.Color(0xff9d20);
  crysMat.emissiveIntensity = 0.6; // 0.9 under bloom out-read the pup's own face
  crysMat.roughness = 0.35;
  crystal.add(crystalCore);

  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  const head = new VoxelModel();
  head.box(-2, 0, 0, 2, 0, 4, G2);
  head.box(-2, 1, 0, 2, 1, 4, G1);
  // Eye course: leave (+/-1, 2, 4) open so the sockets are two cells deep with a single
  // granite nose bridge between them.
  head.box(-2, 2, 0, 2, 2, 3, G1);
  head.set(0, 2, 4, G1);
  head.box(-2, 3, 0, 2, 3, 4, G2);
  head.box(-1, 4, 0, 1, 4, 3, G0);
  head.box(-1, 0, 5, 1, 1, 5, BR);
  head.box(-1, 0, 6, 1, 0, 6, BR);
  // Lit top plane on the snout, or its front face is the darkest thing on the head.
  head.set(-1, 1, 5, G1);
  head.set(0, 1, 5, G0);
  head.set(1, 1, 5, G1);
  head.set(0, 1, 6, NOSE);
  head.set(1, 4, 1, MOSS);
  shadeUnder(head, G3, -2, 2, 0, 2, 0, 6); // jaw shadow = a neck break
  // `glow` routes the iris through setEmissive, so build() batches those cells into the
  // child mesh animate() dims for a squint. `lid` in darkest granite is the socket rim:
  // no AO in build(), so a recess only reads if it is painted.
  eyes2x2(head, {
    inner: 1,
    width: 1,
    y: 1,
    faceZ: 4,
    iris: EYE_IRIS,
    shine: EYE_HOT,
    // bridge in G1, not near-white G0: three bright cells between one-cell eyes made the
    // pale band the loudest thing on the face.
    lid: G3,
    browProud: true,
    bridge: G1,
    glow: EYE_GLOW,
  });
  const headMesh = head.build(0.1, true);
  headMesh.position.set(0, -0.2, 0.06);
  headGroup.add(headMesh);
  const eyeGlow = headMesh.children[0] as THREE.Mesh; // the emissive iris batch

  const mkEar = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.2, 0.16, 0.02);
    g.rotation.set(-0.1, 0, -sign * EAR_TILT);
    // Three courses, not two: a 2x2 slab was a pebble at gameplay distance.
    const ear = new VoxelModel();
    ear.box(0, 0, 0, 1, 2, 0, G2);
    ear.set(sign > 0 ? 0 : 1, 2, 0, G3);
    ear.set(sign > 0 ? 1 : 0, 0, 0, G1);
    const mesh = ear.build(0.1, true);
    mesh.position.y = -0.02;
    g.add(mesh);
    headGroup.add(g);
    return g;
  };
  const earR = mkEar(1);
  const earL = mkEar(-1);

  const tailGroup = new THREE.Group();
  tailGroup.position.set(0, 0.06, -0.4);
  tailGroup.rotation.x = TAIL_UP;
  body.add(tailGroup);
  const tail = new VoxelModel();
  tail.box(-1, 0, -2, 1, 1, 0, G2);
  tail.box(-1, 0, -2, 1, 0, -2, G3);
  tail.set(0, 1, -2, MOSS2);
  const tailMesh = tail.build(0.1, true);
  tailMesh.position.set(0, -0.05, -0.14);
  tailGroup.add(tailMesh);

  const mkLegGroup = (kind: "FL" | "FR" | "BL" | "BR", x: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, LEG_Y, z);
    g.add(buildLeg(kind));
    root.add(g);
    return g;
  };
  const legFL = mkLegGroup("FL", -0.2, 0.24);
  const legFR = mkLegGroup("FR", 0.2, 0.24);
  const legBL = mkLegGroup("BL", -0.21, -0.26);
  const legBR = mkLegGroup("BR", 0.21, -0.26);

  return {
    root,
    parts: {
      body,
      head: headGroup,
      earL,
      earR,
      tail: tailGroup,
      crystal,
      crystalCore,
      eyeGlow,
      legFL,
      legFR,
      legBL,
      legBR,
    },
    height: 0.85,
    radius: 0.5,
  };
}

// Every emissive value below was tuned before the bloom pass, so it is scaled on the way
// out; at face value the sockets and the back-crystal blow into white discs.
const GLOW_TRIM = 0.55;

/** A squint dims the iris: at one cell of iris a geometric squint would be sub-pixel. */
function setEyes(P: Parts, intensity: number, squint: number): void {
  const mat = (P.eyeGlow as THREE.Mesh).material as THREE.MeshStandardMaterial;
  // The extra 0.5: the emissive cells are the DARK iris, so this is an interior gleam,
  // not a light source — brighter and the ember washes out to near-white.
  mat.emissiveIntensity = intensity * GLOW_TRIM * 0.5 * (1 - 0.7 * squint);
}

function setCrystal(P: Parts, intensity: number, scale: number, tilt: number): void {
  const mat = (P.crystalCore as THREE.Mesh).material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = intensity * GLOW_TRIM;
  P.crystal.scale.set(scale, scale, scale);
  P.crystal.rotation.z = 0.12 + tilt;
}

// Cycle slots — see BeastAnimCtx.cycle(). Three stomp rates and two wag rates on one set
// of legs and one tail; off the session clock every walk<->run flip jump-cut the pose,
// and the gait blend can sit on the 0.5 threshold flipping for frames.
const GAIT = 0;
const TAIL = 1;

/** Heavy trot: diagonal leg pairs, sharp footfall weight, body settle. */
function stompGait(P: Parts, ph: number, amp: number, bob: number): void {
  const a = Math.sin(ph);
  const b = Math.sin(ph + Math.PI);
  P.legFL.rotation.x = amp * a;
  P.legBR.rotation.x = amp * a * 0.9;
  P.legFR.rotation.x = amp * b;
  P.legBL.rotation.x = amp * b * 0.9;
  const lift = Math.pow(Math.abs(a), 0.8);
  const impact = Math.pow(Math.abs(Math.cos(ph)), 12);
  P.body.position.y = BODY_Y + bob * lift - 0.022 * impact;
  P.body.scale.set(1 + 0.05 * impact, 1 - 0.1 * impact, 1 + 0.05 * impact);
  P.body.rotation.set(0.03 * Math.sin(ph * 2 + 0.6), 0, 0.05 * a);
  P.head.rotation.set(0.06 * Math.sin(ph * 2 - 0.8), 0, -0.04 * a);
  P.head.position.y = HEAD_Y - 0.02 * impact;
  P.earL.rotation.x = -0.1 + 0.25 * Math.sin(ph * 2 - 1.3);
  P.earR.rotation.x = -0.1 + 0.25 * Math.sin(ph * 2 - 1.5);
  P.tail.rotation.x = TAIL_UP + 0.15 * impact;
  P.crystal.rotation.z = 0.12 + 0.06 * Math.sin(ph * 2 - 1.0);
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const P = rig.parts;
  const t = ctx.time,
    at = ctx.actionTime,
    ms = ctx.moveSpeed;

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

  const blink = Math.pow(Math.max(0, Math.sin(t * 0.61 + 2.0)), 80);

  switch (ctx.action) {
    case "idle": {
      const br = Math.sin(t * 2.0);
      P.body.scale.set(1 - 0.008 * br, 1 + 0.02 * br, 1 - 0.008 * br);
      P.head.rotation.set(
        0.03 * Math.sin(t * 2.0 + 0.8),
        0.14 * Math.tanh(2.0 * Math.sin(t * 0.31)),
        0.07 * Math.sin(t * 0.5),
      );
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

    case "walk": {
      const ph = ctx.cycle(GAIT, 5.5);
      stompGait(P, ph, 0.5, 0.035);
      P.tail.rotation.y = Math.tanh(Math.sin(ctx.cycle(TAIL, 4)) * 2) * 0.25;
      // Crystal pulse as multiples of `ph`, not `t * 5.5`, so it cannot drift off the legs.
      setCrystal(P, 0.9 + 0.2 * Math.abs(Math.sin(ph)), 1, 0.06 * Math.sin(ph * 2 - 1));
      setEyes(P, 1.8, 0.8 * blink);
      break;
    }

    case "run":
    case "fly": {
      const ph = ctx.cycle(GAIT, 8.5);
      stompGait(P, ph, 0.75, 0.05);
      P.body.rotation.x += 0.1 + 0.04 * ms;
      P.head.rotation.x -= 0.08;
      P.tail.rotation.y = Math.tanh(Math.sin(ctx.cycle(TAIL, 6)) * 2) * 0.2;
      P.earL.rotation.x -= 0.25;
      P.earR.rotation.x -= 0.25;
      setCrystal(P, 1.1 + 0.3 * Math.abs(Math.sin(ph)), 1, 0.08 * Math.sin(ph * 2 - 1));
      setEyes(P, 2.0, 0.3);
      break;
    }

    case "swim": {
      const ph = ctx.cycle(GAIT, 7.0);
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

    case "attack": {
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

    case "cast": {
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
      setCrystal(
        P,
        0.9 + 2.2 * rear + 0.6 * Math.sin(t * 10) * rear,
        1 + 0.22 * rear + 0.05 * Math.sin(t * 10) * rear,
        0.05 * Math.sin(t * 10) * rear,
      );
      setEyes(P, 1.8 + 1.8 * rear, 0);
      break;
    }

    case "special": {
      const gather = bump(at, 0, 0.34, 0.7);
      const leap = Math.sin(Math.PI * s01((at - 0.3) / 0.3));
      const land = at > 0.6 ? decay(at - 0.6, 7) : 0;
      const shake = Math.sin(at * 60) * land;
      P.body.position.y = BODY_Y - 0.08 * gather + 0.26 * leap - 0.05 * land;
      P.body.position.x = 0.02 * shake;
      P.body.scale.set(
        1 + 0.07 * gather + 0.08 * land,
        1 - 0.14 * gather + 0.14 * leap - 0.16 * land,
        1 + 0.07 * gather + 0.08 * land,
      );
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
      setCrystal(
        P,
        0.9 + 1.2 * gather + 3.0 * (leap + land) * 0.8,
        1 + 0.1 * gather + 0.3 * leap + 0.15 * land,
        0.1 * shake,
      );
      setEyes(P, 2.2 + 1.6 * leap, 0);
      break;
    }

    case "hurt": {
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

    case "happy": {
      const ph = at * 8;
      const b = Math.abs(Math.sin(ph));
      const land = 1 - b;
      P.body.position.y = BODY_Y + 0.09 * b;
      P.body.scale.set(1 + 0.05 * land, 1 - 0.1 * land * land, 1 + 0.05 * land);
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
      setCrystal(
        P,
        1.2 + 0.8 * Math.abs(Math.sin(at * 10)),
        1 + 0.06 * b,
        0.05 * Math.sin(at * 10),
      );
      setEyes(P, 2.2, 0.45);
      break;
    }
  }
}

export const species: BeastSpecies = {
  id: "boulderpup",
  nameKey: "beast.boulderpup.name",
  element: "rock",
  locomotion: "ground",
  descriptionKey: "beast.boulderpup.desc",
  baseStats: { maxHp: 64, attack: 11, defense: 16, speed: 4.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
