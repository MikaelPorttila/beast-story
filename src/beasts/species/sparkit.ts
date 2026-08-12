import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { makeGlowSprite } from "./glowsprite";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";

// Sparkit — crackling electric rodent, ~0.6 m tall, always jittery.
// Chrome yellow stays bright: at 60% luminance it photographed as dull brass in shade.
// Iris is dark WARM ink — a neutral dark cell lit only by sky bounce renders blue.
const YEL = 0xffcb2e;
const YEL_LIGHT = 0xfff09a;
const YEL_DARK = 0xd99a1c;
const CREAM = 0xf3dc93;
const INK = 0x211f1a;
const CHEEK = 0xff8a2b;
const SPARK_CORE = 0xfff2b8;
const IRIS = 0x3d2c11;
const EYE_GLINT = 0xf2f7ff;
const LID = 0xdfa41d;
const PAW = 0xffe9a8;

const S = 0.1; // voxel scale

/** Base transforms per part, relative to parent: [px, py, pz, rx, ry, rz] */
const BASE: Record<string, readonly [number, number, number, number, number, number]> = {
  body: [0, 0.12, 0, 0, 0, 0],
  head: [0, 0.22, 0.2, 0, 0, 0],
  earL: [0.1, 0.26, -0.04, -0.08, 0, 0.28],
  earR: [-0.1, 0.26, -0.04, -0.08, 0, -0.28],
  // Cheek sparks sit low and outboard: at eye height they merged with the eye row.
  sparkL: [0.29, -0.02, 0.06, 0, Math.PI / 2, 0],
  sparkR: [-0.29, -0.02, 0.06, 0, -Math.PI / 2, 0],
  tail: [0, 0.16, -0.26, -0.3, 0, 0],
  tailTip: [0, 0.36, -0.18, 0.55, 0, 0],
  legFL: [0.13, 0.06, 0.15, 0, 0, 0],
  legFR: [-0.13, 0.06, 0.15, 0, 0, 0],
  legBL: [0.15, 0.06, -0.13, 0, 0, 0],
  legBR: [-0.15, 0.06, -0.13, 0, 0, 0],
};

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};

  const pivot = (name: string, parent: THREE.Object3D): THREE.Group => {
    const g = new THREE.Group();
    const b = BASE[name];
    g.position.set(b[0], b[1], b[2]);
    g.rotation.set(b[3], b[4], b[5]);
    parent.add(g);
    parts[name] = g;
    return g;
  };

  const body = pivot("body", root);
  const bm = new VoxelModel();
  bm.ellipsoid(0, 2.2, 0, 2.8, 2.3, 3.6, YEL);
  bm.ellipsoid(0, 1.3, 1.0, 2.0, 1.5, 2.5, CREAM);
  // Rim and shade before the bolt: all three claim a column's topmost cell, bolt wins.
  rimTop(bm, YEL_LIGHT, -3, 3, 0, 5, -4, 4);
  shadeUnder(bm, YEL_DARK, -3, 3, 0, 3, -4, 4);
  const zig = [1, 2, 1, 0, 1, 2, 1]; // mirrored bolt path along the spine
  for (let z = -3; z <= 3; z++) {
    const xm = zig[z + 3];
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? xm : -xm;
      for (let y = 5; y >= 0; y--) {
        if (bm.has(sx, y, z)) {
          bm.set(sx, y, z, INK);
          break;
        }
      }
      if (xm === 0) {
        break;
      }
    }
  }
  const bodyMesh = bm.build(S);
  bodyMesh.position.y = -0.06;
  body.add(bodyMesh);

  const head = pivot("head", body);
  const hm = new VoxelModel();
  hm.ellipsoid(0, 1.9, 0.2, 2.8, 2.1, 2.2, YEL);
  hm.box(-3, 0, 2, 3, 4, 2, YEL);
  rimTop(hm, YEL_LIGHT, -2, 2, 0, 5, -2, 2);
  shadeUnder(hm, YEL_DARK, -3, 3, 0, 1, -2, 1);
  // lowerLid off: a lid row above AND below grew the eye into a 2x4 dark column.
  eyes2x2(hm, {
    inner: 1,
    y: 2,
    faceZ: 2,
    iris: IRIS,
    shine: EYE_GLINT,
    lid: LID,
    browProud: true,
    bridge: YEL_LIGHT,
  });
  // Muzzle ONE cell wide: three cells proud at z=3 stood in front of the inner eye
  // column and hid a third of the iris.
  hm.box(0, 1, 3, 0, 2, 3, YEL);
  hm.set(0, 2, 4, INK);
  hm.set(0, 1, 4, EYE_GLINT);
  const headMesh = hm.build(S);
  headMesh.position.set(0, -0.14, 0.02);
  head.add(headMesh);

  const mkEar = (name: string): void => {
    const g = pivot(name, head);
    const em = new VoxelModel();
    em.box(-1, 0, 0, 1, 1, 0, YEL);
    em.set(0, 2, 0, INK);
    g.add(em.build(S));
  };
  mkEar("earL");
  mkEar("earR");

  const mkSpark = (name: string): void => {
    const g = pivot(name, head);
    const sv = new VoxelModel();
    sv.set(0, 1, 0, CHEEK);
    // 0.45, halved for the bloom pass, and animate() scales this group to 2.6x on a
    // special — brighter and the cheeks became two white discs.
    sv.markEmissive(CHEEK, 0.45);
    const m = sv.build(S);
    m.position.y = -0.05; // build() anchors y=0 at the lowest voxel; keeps the spark put
    g.add(m);
    const cheekGlow = makeGlowSprite(0xffe680, 0.13, 0.08);
    cheekGlow.position.set(0, 0, 0.06);
    g.add(cheekGlow);
  };
  mkSpark("sparkL");
  mkSpark("sparkR");

  const tailG = pivot("tail", body);
  // The bolt runs dark at the root and hotter each step: pale-on-pale it vanished
  // against sky, and the dark root also separates the tail from the yellow body.
  const t1 = new VoxelModel();
  t1.box(0, 0, 0, 1, 1, 0, INK);
  t1.box(0, 1, -1, 1, 2, -1, YEL_DARK);
  t1.box(0, 2, -2, 1, 3, -2, YEL);
  const m1 = t1.build(S, false);
  m1.position.set(-0.1, 0, -0.05);
  tailG.add(m1);

  const tipG = pivot("tailTip", tailG);
  const t2 = new VoxelModel();
  t2.box(0, 0, 0, 1, 1, 0, YEL);
  t2.box(0, 1, 1, 1, 2, 1, YEL_LIGHT);
  t2.box(-1, 3, 1, 2, 3, 1, YEL_LIGHT);
  // Ink caps give the flare hard corners — the same INK as the back stripes.
  t2.set(-1, 3, 1, INK);
  t2.set(2, 3, 1, INK);
  t2.box(0, 4, 1, 1, 4, 1, SPARK_CORE);
  // Halved for bloom: at 0.7/1.05 the tip was a clipped white cube with no zigzag left.
  t2.markEmissive(YEL_LIGHT, 0.34);
  t2.markEmissive(SPARK_CORE, 0.5);
  const m2 = t2.build(S, false);
  m2.position.set(-0.1, 0, -0.05);
  tipG.add(m2);
  // 0.20/0.07: the bloom pass already haloes the emissive tip, and a wider additive
  // disc buried the bolt — which is this species' silhouette read. See glowsprite.ts.
  const tipGlow = makeGlowSprite(0xffe680, 0.2, 0.07);
  tipGlow.position.set(0, 0.47, 0.05);
  tipG.add(tipGlow);

  const mkLeg = (name: string): void => {
    const g = pivot(name, body);
    const lv = new VoxelModel();
    lv.box(0, 0, 0, 1, 1, 1, YEL_DARK);
    lv.box(0, 0, 0, 1, 0, 1, PAW);
    const m = lv.build(S);
    m.position.y = -0.18;
    g.add(m);
  };
  mkLeg("legFL");
  mkLeg("legFR");
  mkLeg("legBL");
  mkLeg("legBR");

  return { root, parts, height: 0.62, radius: 0.3 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smooth(v: number): number {
  return v * v * (3 - 2 * v);
}
function easeOutCubic(v: number): number {
  const u = 1 - v;
  return 1 - u * u * u;
}
function pulse(x: number, sharp: number): number {
  const s = Math.sin(x);
  return s > 0 ? Math.pow(s, sharp) : 0;
}

// Scamper phase, integrated — see BeastAnimCtx.cycle(). Gait-scaled, which is exactly
// the shape that made `t * freq` teleport the legs on a change of pace.
const GAIT = 0;

function resetPose(parts: Record<string, THREE.Object3D>): void {
  for (const k in BASE) {
    const o = parts[k];
    const b = BASE[k];
    o.position.set(b[0], b[1], b[2]);
    o.rotation.set(b[3], b[4], b[5]);
    o.scale.set(1, 1, 1);
  }
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const p = rig.parts;
  resetPose(p);
  const body = p["body"];
  const head = p["head"];
  const earL = p["earL"];
  const earR = p["earR"];
  const sparkL = p["sparkL"];
  const sparkR = p["sparkR"];
  const tail = p["tail"];
  const tailTip = p["tailTip"];
  const legFL = p["legFL"];
  const legFR = p["legFR"];
  const legBL = p["legBL"];
  const legBR = p["legBR"];
  const t = ctx.time;
  const at = ctx.actionTime;

  switch (ctx.action) {
    case "idle": {
      const breath = Math.sin(t * 3.4);
      body.scale.y += breath * 0.025;
      body.scale.z -= breath * 0.012;
      const look = Math.tanh((Math.sin(t * 0.9) + 0.6 * Math.sin(t * 1.9 + 2.0)) * 2.2);
      head.rotation.y += look * 0.4;
      head.rotation.x += Math.sin(t * 2.8) * 0.04 + pulse(t * 0.7 + 2.0, 26) * 0.18;
      head.position.y += Math.sin(t * 7.0) * 0.004;
      earL.rotation.z += pulse(t * 1.15 + 0.3, 30) * 0.35;
      earR.rotation.z -= pulse(t * 1.45 + 3.1, 30) * 0.35;
      const crackle = pulse(t * 1.7 + 1.0, 14);
      tail.rotation.z += Math.sin(t * 1.6) * 0.07 + crackle * Math.sin(t * 43.0) * 0.12;
      tail.rotation.x += crackle * Math.sin(t * 37.0) * 0.08;
      tailTip.rotation.z += Math.sin(t * 2.1 + 0.6) * 0.1 + crackle * Math.sin(t * 51.0) * 0.22;
      sparkL.scale.setScalar(1 + pulse(t * 2.3 + 0.5, 16) * 0.7);
      sparkR.scale.setScalar(1 + pulse(t * 2.0 + 3.6, 16) * 0.7);
      legFL.rotation.x += pulse(t * 1.3 + 5.0, 22) * 0.5;
      legFR.rotation.x += pulse(t * 1.1 + 1.2, 22) * 0.5;
      body.rotation.z += Math.sin(t * 1.1) * 0.02;
      break;
    }

    case "walk":
    case "run":
    case "swim":
    case "fly": {
      const g = ctx.moveSpeed;
      const freq = 9.5 + g * 5.5;
      const ph = ctx.cycle(GAIT, freq);
      const stride = 0.55 + g * 0.5;
      legFL.rotation.x += Math.sin(ph) * stride;
      legFR.rotation.x += Math.sin(ph + 0.35) * stride;
      legBL.rotation.x += Math.sin(ph + 2.5) * stride * 1.15;
      legBR.rotation.x += Math.sin(ph + 2.85) * stride * 1.15;
      const arc = Math.max(0, Math.sin(ph + 1.1));
      body.position.y += arc * arc * (0.02 + 0.05 * g);
      body.rotation.x += Math.sin(ph + 0.7) * 0.1 * (0.35 + g);
      const stretch = Math.sin(ph + 1.0) * 0.05 * (0.5 + g);
      body.scale.z += stretch;
      body.scale.y -= stretch * 0.8;
      head.rotation.x += -Math.sin(ph + 0.7) * 0.07;
      head.rotation.y += Math.sin(t * 3.1) * 0.06;
      earL.rotation.x += -0.35 * g + Math.sin(ph - 0.6) * 0.08;
      earR.rotation.x += -0.35 * g + Math.sin(ph - 0.9) * 0.08;
      tail.rotation.x += -0.4 * g + Math.sin(ph - 1.2) * 0.12;
      tailTip.rotation.x += Math.sin(ph - 2.0) * 0.2 + Math.sin(t * 40.0) * 0.06 * g;
      tailTip.rotation.z += Math.sin(t * 35.0) * 0.05 * g;
      const hopP = pulse(t * 0.85 + 0.7, 9) * (0.3 + g * 0.7);
      body.position.y += hopP * 0.1;
      body.rotation.x += -hopP * 0.25;
      legFL.rotation.x += hopP * 0.7;
      legFR.rotation.x += hopP * 0.7;
      legBL.rotation.x += hopP * 0.5;
      legBR.rotation.x += hopP * 0.5;
      sparkL.scale.setScalar(1 + g * 0.3 + hopP * 0.5);
      sparkR.scale.setScalar(1 + g * 0.3 + hopP * 0.5);
      break;
    }

    case "attack": {
      const coilK = smooth(clamp01(at / 0.12));
      const strike = easeOutCubic(clamp01((at - 0.12) / 0.1));
      const rec = smooth(clamp01((at - 0.3) / 0.35));
      const lunge = strike * (1 - rec);
      const coil = coilK * (1 - strike);
      body.position.z += -coil * 0.07 + lunge * 0.2;
      body.position.y += -coil * 0.04 + lunge * 0.03;
      body.rotation.x += -coil * 0.18 + lunge * 0.22;
      body.scale.z += -coil * 0.12 + lunge * 0.15;
      body.scale.y += coil * 0.08 - lunge * 0.08;
      head.rotation.x += -coil * 0.25 + lunge * 0.35;
      earL.rotation.x += -(coil + lunge) * 0.6;
      earR.rotation.x += -(coil + lunge) * 0.6;
      tail.rotation.x += coil * 0.4 - lunge * 0.6;
      tailTip.rotation.x += -coil * 0.3 + lunge * 0.8;
      sparkL.scale.setScalar(1 + lunge * 1.2);
      sparkR.scale.setScalar(1 + lunge * 1.2);
      legFL.rotation.x += coil * 0.5 - lunge * 1.1;
      legFR.rotation.x += coil * 0.5 - lunge * 1.1;
      legBL.rotation.x += -coil * 0.5 + lunge * 0.8;
      legBR.rotation.x += -coil * 0.5 + lunge * 0.8;
      break;
    }

    case "cast": {
      const up = smooth(clamp01(at / 0.22));
      body.rotation.x += -0.5 * up;
      body.position.y += 0.05 * up;
      body.position.z += -0.03 * up;
      legFL.rotation.x += (-1.25 + Math.sin(t * 22.0) * 0.12) * up;
      legFR.rotation.x += (-1.25 + Math.sin(t * 22.0 + 2.1) * 0.12) * up;
      legBL.rotation.x += 0.5 * up;
      legBR.rotation.x += 0.5 * up;
      head.rotation.x += 0.42 * up + Math.sin(t * 26.0) * 0.02 * up;
      earL.rotation.x += 0.2 * up;
      earR.rotation.x += 0.2 * up;
      earL.rotation.z += -0.14 * up;
      earR.rotation.z += 0.14 * up;
      tail.rotation.x += 0.25 * up + Math.sin(t * 55.0) * 0.05 * up;
      tailTip.rotation.x += -0.35 * up + Math.sin(t * 55.0 + 1.5) * 0.1 * up;
      sparkL.scale.setScalar(1 + up * (0.9 + Math.sin(t * 34.0) * 0.35));
      sparkR.scale.setScalar(1 + up * (0.9 + Math.sin(t * 34.0 + 1.6) * 0.35));
      break;
    }

    case "special": {
      const wind = smooth(clamp01(at / 0.15));
      const spinT = clamp01((at - 0.15) / 0.6);
      const s = easeOutCubic(spinT);
      const air = Math.sin(spinT * Math.PI);
      body.rotation.y += s * Math.PI * 6;
      body.position.y += air * 0.2 - wind * 0.04;
      body.scale.y += -wind * 0.22 + air * 0.15;
      body.scale.x += wind * 0.1 - air * 0.06;
      body.scale.z += wind * 0.1 - air * 0.06;
      legFL.rotation.x += wind * 0.3 - air * 0.9;
      legFR.rotation.x += wind * 0.3 - air * 0.9;
      legBL.rotation.x += -wind * 0.3 + air * 0.9;
      legBR.rotation.x += -wind * 0.3 + air * 0.9;
      head.rotation.x += -0.2 * air;
      earL.rotation.z += air * 0.5;
      earR.rotation.z += -air * 0.5;
      tail.rotation.x += -air * 0.7 + Math.sin(t * 40.0) * 0.08 * air;
      tailTip.rotation.x += air * 0.4 + Math.sin(t * 47.0) * 0.1 * air;
      sparkL.scale.setScalar(1 + air * 1.6 + Math.sin(t * 45.0) * 0.2 * air);
      sparkR.scale.setScalar(1 + air * 1.6 + Math.sin(t * 45.0 + 2.0) * 0.2 * air);
      if (at > 0.78) {
        const w = at - 0.78;
        const d = Math.exp(-w * 6.0);
        body.rotation.z += Math.sin(w * 26.0) * 0.06 * d;
        body.scale.y += -Math.exp(-w * 10.0) * 0.08;
      }
      break;
    }

    case "hurt": {
      const d = Math.exp(-at * 6.0);
      body.position.x += Math.sin(at * 50.0) * 0.04 * d;
      body.rotation.z += Math.sin(at * 47.0 + 1.0) * 0.12 * d;
      body.position.z += -0.05 * d;
      body.scale.y += -0.15 * d;
      body.scale.x += 0.09 * d;
      body.scale.z += 0.09 * d;
      head.rotation.x += -0.28 * d;
      earL.rotation.z += 0.5 * d;
      earR.rotation.z += -0.5 * d;
      earL.rotation.x += -0.4 * d;
      earR.rotation.x += -0.4 * d;
      tail.rotation.x += -0.5 * d + Math.sin(at * 44.0) * 0.1 * d;
      tailTip.rotation.x += 0.3 * d + Math.sin(at * 52.0) * 0.15 * d;
      const fizzle = 1 - d * 0.55;
      sparkL.scale.setScalar(fizzle);
      sparkR.scale.setScalar(fizzle);
      legFL.rotation.x += 0.3 * d;
      legFR.rotation.x += 0.3 * d;
      legBL.rotation.x += -0.3 * d;
      legBR.rotation.x += -0.3 * d;
      break;
    }

    case "happy": {
      const hop = Math.abs(Math.sin(at * 7.5));
      const hu = hop * hop;
      body.position.y += hu * 0.12;
      body.scale.y += -0.1 + hu * 0.2;
      body.scale.x += 0.06 - hu * 0.08;
      body.scale.z += 0.06 - hu * 0.08;
      const spinT = smooth(clamp01((at - 0.5) / 0.4));
      body.rotation.y += spinT * Math.PI * 2 + Math.sin(at * 4.0) * 0.15;
      earL.rotation.z += Math.sin(at * 15.0) * 0.25;
      earR.rotation.z += Math.sin(at * 15.0 + Math.PI) * 0.25;
      tail.rotation.z += Math.sin(at * 11.0) * 0.45;
      tailTip.rotation.z += Math.sin(at * 11.0 - 0.8) * 0.5;
      head.rotation.z += Math.sin(at * 7.5 + 1.0) * 0.2;
      sparkL.scale.setScalar(1.2 + Math.sin(at * 13.0) * 0.5);
      sparkR.scale.setScalar(1.2 + Math.sin(at * 13.0 + 1.5) * 0.5);
      legFL.rotation.x += Math.sin(at * 15.0) * 0.4;
      legFR.rotation.x += Math.sin(at * 15.0 + Math.PI) * 0.4;
      legBL.rotation.x += Math.sin(at * 15.0 + 1.2) * 0.35;
      legBR.rotation.x += Math.sin(at * 15.0 + 4.3) * 0.35;
      break;
    }
  }

  // Ambient static: Sparkit is never fully still.
  const jit = Math.sin(t * 31.0) * Math.sin(t * 17.3);
  tailTip.rotation.z += jit * 0.04;
  tail.rotation.z += jit * 0.02;
  const crackleBurst = pulse(t * 1.9 + 0.4, 18);
  tailTip.rotation.x += crackleBurst * Math.sin(t * 57.0) * 0.06;
  tailTip.rotation.z += crackleBurst * Math.sin(t * 49.0) * 0.05;
  earL.rotation.z += Math.sin(t * 21.0) * 0.015;
  earR.rotation.z -= Math.sin(t * 19.0) * 0.015;
  head.rotation.z += Math.sin(t * 13.7) * 0.008;
}

export const skills: SkillDef[] = [
  {
    id: "sparkit.static-zap",
    nameKey: "skill.sparkit.static-zap.name",
    descriptionKey: "skill.sparkit.static-zap.desc",
    element: "electric",
    targeting: "projectile",
    cost: 5,
    cooldown: 1.5,
    power: 9,
    range: 13,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "sparkit.volt-dash",
    nameKey: "skill.sparkit.volt-dash.name",
    descriptionKey: "skill.sparkit.volt-dash.desc",
    element: "electric",
    targeting: "melee",
    cost: 10,
    cooldown: 4,
    power: 17,
    range: 3.5,
    learnAtLevel: 4,
    castAnim: "attack",
  },
  {
    id: "sparkit.thunder-coil",
    nameKey: "skill.sparkit.thunder-coil.name",
    descriptionKey: "skill.sparkit.thunder-coil.desc",
    element: "electric",
    targeting: "aoe",
    cost: 18,
    cooldown: 8,
    power: 27,
    range: 5.5,
    storePrice: 260,
    castAnim: "cast",
  },
  {
    id: "sparkit.gigavolt-crash",
    nameKey: "skill.sparkit.gigavolt-crash.name",
    descriptionKey: "skill.sparkit.gigavolt-crash.desc",
    element: "electric",
    targeting: "beam",
    cost: 24,
    cooldown: 11,
    power: 42,
    range: 12,
    storePrice: 380,
    castAnim: "special",
  },
];

export const species: BeastSpecies = {
  id: "sparkit",
  nameKey: "beast.sparkit.name",
  element: "electric",
  locomotion: "ground",
  descriptionKey: "beast.sparkit.desc",
  baseStats: { maxHp: 42, attack: 13, defense: 7, speed: 5.4 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
