import * as THREE from "three";
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from "../../core/types";
import { VoxelModel } from "../../core/voxel";
import { eyes2x2, rimTop, shadeUnder } from "./voxelshade";
import { makeContactBlob, updateContactBlob } from "./contactshadow";

// Frostwing — snowy owl of the high glaciers. Voxel scale 0.1: ~0.92 tall, ~2.2 wingspan.
// Both whites are WARM-biased: in shade the only light is blue sky bounce, and a neutral
// white renders slate. The ice reads through the saturated cerulean barring.
const WHITE = 0xfffaf1;
const CREAM = 0xf7ecda;
const SPECK = 0x63c3f2;
const SPECK2 = 0x2b93d8;
const UNDER = 0xbdb7ae;
const SHADOW = 0x968f88;
const DISC = 0x86d2f7;
const BEAK = 0xff8f2e;
const BEAK_DK = 0xc25c12;
const IRIS = 0x1e2a3c;
const EYE_LT = 0xfdfeff;
const BROW = 0xe8a63a;
// Muted amber, not the beak's orange: the feet sit 0.09 apart and merged into one bar.
const TALON = 0xcf9147;

const BODY_Y = 0.38;
// HEAD_Y 0.32: the chin sits at HEAD_Y - 0.08 and the wing slab reaches +0.13, so under
// ~0.28 the wing roots cross the facial disc.
const HEAD_X = 0,
  HEAD_Y = 0.32,
  HEAD_Z = 0.15;
/** Hover height BeastActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;

type Parts = Record<string, THREE.Object3D>;

const s01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => {
  const x = s01(t);
  return x * x * (3 - 2 * x);
};
const decay = (t: number, r: number): number => Math.exp(-r * Math.max(0, t));

// One integrated wing/leg phase — see BeastAnimCtx.cycle(). Three rates on the same wings
// (6.5 hopping, 8.5 skimming, 3.6-6.2 cruising); off the session clock every gait change
// and every nudge of the gait blend jump-cut the pose.
const BEAT = 0;
/** Eased 0 -> 1 -> 0 bump inside [a, b]; riseFrac = fraction of the window spent rising. */
function bump(t: number, a: number, b: number, riseFrac = 0.4): number {
  if (t <= a || t >= b) {
    return 0;
  }
  const u = (t - a) / (b - a);
  return u < riseFrac ? smooth(u / riseFrac) : smooth((1 - u) / (1 - riseFrac));
}

export const skills: SkillDef[] = [
  {
    id: "frostwing.frost-dart",
    nameKey: "skill.frostwing.frost-dart.name",
    descriptionKey: "skill.frostwing.frost-dart.desc",
    element: "ice",
    targeting: "projectile",
    cost: 6,
    cooldown: 1.8,
    power: 11,
    range: 20,
    learnAtLevel: 1,
    castAnim: "attack",
  },
  {
    id: "frostwing.blizzard-wing",
    nameKey: "skill.frostwing.blizzard-wing.name",
    descriptionKey: "skill.frostwing.blizzard-wing.desc",
    element: "ice",
    targeting: "aoe",
    cost: 14,
    cooldown: 6,
    power: 22,
    range: 6,
    learnAtLevel: 5,
    castAnim: "cast",
  },
  {
    id: "frostwing.aurora-veil",
    nameKey: "skill.frostwing.aurora-veil.name",
    descriptionKey: "skill.frostwing.aurora-veil.desc",
    element: "ice",
    targeting: "support",
    cost: 18,
    cooldown: 9,
    power: 20,
    range: 8,
    storePrice: 220,
    castAnim: "cast",
  },
  {
    id: "frostwing.comet-dive",
    nameKey: "skill.frostwing.comet-dive.name",
    descriptionKey: "skill.frostwing.comet-dive.desc",
    element: "ice",
    targeting: "melee",
    cost: 22,
    cooldown: 11,
    power: 40,
    range: 4,
    storePrice: 360,
    castAnim: "special",
  },
];

// One hinged wing section, cells running outward from the pivot along +/-X. Constant-chord
// segments in a hinge chain read as a jointed ARM, so the chord tapers 7 cells to 1 and the
// trailing edge is scalloped. Only the leading two cells are two rows thick: a 1-cell sheet
// is see-through edge-on, a 2-cell one is a plank. Table written once, mirrored by `sign`.
function wingSectionMesh(sign: number, kind: "inner" | "mid" | "tip"): THREE.Mesh {
  const m = new VoxelModel();
  const X = (d: number): number => (sign > 0 ? d : -d - 1); // exact cell mirror
  const one = (d: number, y: number, z: number, c: number): void => {
    m.set(X(d), y, z, c);
  };
  /** One chord column: `z1` is the leading edge, `z0` the trailing edge. */
  const vane = (d: number, z0: number, z1: number, top: number, edge: number): void => {
    for (let z = z0; z <= z1; z++) {
      one(d, 0, z, z === z0 ? edge : top);
      if (z >= z1 - 1) {
        one(d, -1, z, UNDER);
      }
    }
  };
  if (kind === "inner") {
    const chord: Array<[number, number]> = [
      [-3, 3],
      [-2, 3],
      [-3, 2],
    ];
    chord.forEach(([z0, z1], d) => vane(d, z0, z1, WHITE, SPECK));
    for (let d = 0; d <= 2; d++) {
      one(d, 1, 3 - (d === 2 ? 1 : 0), CREAM);
    }
    one(0, -1, 3, SHADOW);
    one(1, -1, 3, SHADOW);
  } else if (kind === "mid") {
    const chord: Array<[number, number]> = [
      [-4, 1],
      [-3, 1],
      [-4, 0],
    ];
    chord.forEach(([z0, z1], d) => vane(d, z0, z1, WHITE, d === 2 ? SPECK2 : SPECK));
    for (let d = 0; d <= 2; d++) {
      one(d, 1, 1 - (d === 2 ? 1 : 0), CREAM);
    }
  } else {
    // Gaps BETWEEN the primaries are the point: a solid triangle reads as a fin.
    const finger: Array<[number, number]> = [
      [-5, 0],
      [-5, -1],
      [-4, -2],
    ];
    finger.forEach(([z0, z1], d) => vane(d, z0, z1, d === 0 ? WHITE : SPECK, SPECK2));
    one(0, 0, 0, CREAM);
  }
  // No emissive on a wing: it outlined the trailing edge in neon and pulled the eye off.
  const mesh = m.build(0.1, false);
  mesh.position.y = -0.05;
  return mesh;
}

function buildRig(): BeastRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  // The barrel must be at least as big as the skull, or the owl reads as a face with wings.
  const torso = new VoxelModel();
  torso.ellipsoid(0, 3, 0, 3.2, 2.8, 2.7, WHITE);
  // Asymmetric bib: a symmetric five-cell cross read as a medical plus sign.
  torso.set(1, 4, 2, SPECK);
  torso.set(1, 3, 2, SPECK);
  torso.set(0, 3, 2, SPECK2);
  torso.set(2, 3, 1, SPECK);
  torso.set(0, 2, 2, CREAM);
  torso.set(-1, 2, 2, CREAM);
  torso.set(1, 2, 2, CREAM);
  torso.set(0, 5, 1, SPECK);
  torso.set(1, 5, -1, SPECK);
  torso.set(-1, 5, 0, SPECK2);
  torso.set(2, 4, 0, SPECK);
  torso.set(-2, 4, -1, SPECK2);
  shadeUnder(torso, UNDER, -2, 2, 0, 2, -2, 2);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.28, 0);
  body.add(torsoMesh);

  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  const head = new VoxelModel();
  head.ellipsoid(0, 2.2, -0.2, 3.1, 2.5, 2.4, WHITE);
  // The disc is a built plate: the skull's curve is three cells wide at the face plane. A
  // heart, warmer than the crown — a plain white rectangle read as a skull mask. Row 4 is
  // half-width 3 because the lid row lands there.
  const discRows: Array<[number, number]> = [
    [5, 2],
    [4, 3],
    [3, 3],
    [2, 3],
    [1, 2],
    [0, 1],
  ];
  for (const [y, hw] of discRows) {
    for (let x = -hw; x <= hw; x++) {
      head.set(x, y, 2, CREAM);
    }
    head.set(-hw, y, 2, DISC);
    head.set(hw, y, 2, DISC);
  }
  rimTop(head, CREAM, -3, 3, 0, 6, -2, 1);
  shadeUnder(head, UNDER, -3, 3, 0, 1, -2, 2);
  // Deeper shade under the jaw: the neck break between two snow-white masses.
  head.set(0, 0, 1, SHADOW);
  head.set(1, 0, 1, SHADOW);
  head.set(-1, 0, 1, SHADOW);
  eyes2x2(head, {
    inner: 1,
    y: 2,
    faceZ: 2,
    iris: IRIS,
    shine: EYE_LT,
    // The gold survives as one brow row per eye; a 2x3 gold iris read as a welding mask.
    lid: BROW,
    bridge: WHITE,
  });
  // Stepped warm-orange wedge, lit on top and shaded under: in slate grey the beak did not
  // exist in any capture.
  head.set(0, 1, 3, BEAK);
  head.set(0, 1, 4, BEAK);
  head.set(0, 0, 3, BEAK_DK);
  head.set(0, 0, 4, BEAK_DK);
  head.set(1, 5, 0, SPECK);
  head.set(-1, 5, 0, SPECK2);
  head.set(0, 5, -1, SPECK);
  const headMesh = head.build(0.1, true);
  // +0.05z pays for the beak: build() centres on the bounding box.
  headMesh.position.set(0, -0.08, 0.05);
  headGroup.add(headMesh);

  const mkWing = (sign: number): [THREE.Group, THREE.Group, THREE.Group] => {
    const rootG = new THREE.Group();
    // |x| = 0.20 against a 0.32 half-width buries the root a cell inside the barrel; y at
    // shoulder height, since armpit level hung the wings below the bird.
    rootG.position.set(sign * 0.2, 0.06, -0.06);
    rootG.add(wingSectionMesh(sign, "inner"));
    const midG = new THREE.Group();
    midG.position.set(sign * 0.26, 0, -0.04); // each joint steps aft: swept plan form
    midG.add(wingSectionMesh(sign, "mid"));
    rootG.add(midG);
    const tipG = new THREE.Group();
    tipG.position.set(sign * 0.26, 0, -0.04);
    tipG.add(wingSectionMesh(sign, "tip"));
    midG.add(tipG);
    body.add(rootG);
    return [rootG, midG, tipG];
  };
  const [wingR, wingRMid, wingRTip] = mkWing(1);
  const [wingL, wingLMid, wingLTip] = mkWing(-1);

  const tailGroup = new THREE.Group();
  tailGroup.position.set(0, -0.14, -0.18);
  body.add(tailGroup);
  const tail = new VoxelModel();
  const fan = [5, 4, 3]; // aft length by |x|, so the two halves cannot drift apart
  for (let x = -2; x <= 2; x++) {
    const len = fan[Math.abs(x)];
    for (let z = 0; z >= -len; z--) {
      tail.set(x, 0, z, WHITE);
      tail.set(x, -1, z, UNDER);
    }
  }
  for (let z = 0; z >= -4; z--) {
    tail.set(1, 0, z, SPECK);
    tail.set(-1, 0, z, SPECK);
  }
  for (let x = -2; x <= 2; x++) {
    tail.set(x, 0, -3, SPECK2);
  }
  tail.set(0, 0, -5, SPECK2);
  const tailMesh = tail.build(0.1, true);
  tailMesh.position.set(0, -0.02, -0.28);
  tailGroup.add(tailMesh);

  const mkLeg = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.09, -0.24, 0.03);
    const foot = new VoxelModel();
    foot.box(0, 0, 0, 0, 0, 1, TALON); // ONE cell wide, so the pair reads as two feet
    foot.set(0, 0, 2, TALON);
    const footMesh = foot.build(0.1, true);
    footMesh.position.set(0, -0.12, 0.02);
    g.add(footMesh);
    body.add(g);
    return g;
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  // Ground contact blob — see contactshadow.ts.
  const blob = makeContactBlob(0.62, HOVER);
  root.add(blob);

  return {
    root,
    parts: {
      body,
      head: headGroup,
      tail: tailGroup,
      wingL,
      wingLMid,
      wingLTip,
      wingR,
      wingRMid,
      wingRTip,
      legL,
      legR,
      blob,
    },
    height: 0.92,
    radius: 0.45,
  };
}

// Baked-in wing attitude, applied in every action. Euler order XYZ, so Z (dihedral) applies
// before Y (sweep): raise the plane, then swing it aft.
const DIHEDRAL = 0.22; // shoulder lift; 0.34 read as a shrug and crowded the head
const SWEEP_AFT = 0.34; // constant aft sweep at every joint — the swept owl plan form

/** fold: 0 = spread, 1 = folded against the body. up > 0 raises the wings further. */
function poseWings(P: Parts, fold: number, up: number, midUp: number, tipUp: number): void {
  const sweep = SWEEP_AFT + 1.0 * fold;
  const droop = 0.24 * fold;
  const z0 = DIHEDRAL - droop + up;
  const z1 = DIHEDRAL * 0.55 + midUp;
  const z2 = DIHEDRAL * 0.35 + tipUp;
  P.wingL.rotation.set(0, -sweep, -z0);
  P.wingR.rotation.set(0, sweep, z0);
  P.wingLMid.rotation.set(0, -0.55 * fold - SWEEP_AFT * 0.6, -z1);
  P.wingRMid.rotation.set(0, 0.55 * fold + SWEEP_AFT * 0.6, z1);
  P.wingLTip.rotation.set(0, -0.5 * fold - SWEEP_AFT * 0.5, -z2);
  P.wingRTip.rotation.set(0, 0.5 * fold + SWEEP_AFT * 0.5, z2);
}

function animate(rig: BeastRig, ctx: BeastAnimCtx): void {
  const P = rig.parts;
  const t = ctx.time,
    at = ctx.actionTime,
    ms = ctx.moveSpeed;

  updateContactBlob(P.blob, rig.root, 1 + 0.35 * Math.max(0, -P.wingL.rotation.z), ctx.altitude);

  P.body.position.set(0, BODY_Y, 0);
  P.body.rotation.set(0, 0, 0);
  P.body.scale.set(1, 1, 1);
  P.head.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  P.head.rotation.set(0, 0, 0);
  P.tail.rotation.set(0.15, 0, 0);
  P.legL.rotation.set(0, 0, 0);
  P.legR.rotation.set(0, 0, 0);

  switch (ctx.action) {
    case "idle": {
      const br = Math.sin(t * 1.7);
      P.body.scale.set(1 - br * 0.008, 1 + br * 0.022, 1 - br * 0.008);
      P.body.position.y = BODY_Y + br * 0.006;
      const ruffle = Math.pow(Math.max(0, Math.sin(t * 0.21 + 1.3)), 24);
      poseWings(
        P,
        1 - 0.25 * ruffle,
        0.025 * br + 0.16 * ruffle * Math.sin(t * 26),
        0.06 * ruffle * Math.sin(t * 26 - 0.5),
        0.09 * ruffle * Math.sin(t * 26 - 1.0),
      );
      P.head.rotation.set(
        0.05 * Math.sin(t * 1.7 + 0.6),
        0.7 * Math.tanh(2.2 * Math.sin(t * 0.42)),
        0.16 * Math.sin(t * 0.83 + 1.7),
      );
      P.tail.rotation.set(0.15 + 0.03 * br, 0.08 * Math.sin(t * 0.9), 0);
      P.legL.rotation.x = 0.02 * br;
      P.legR.rotation.x = -0.02 * br;
      break;
    }

    case "walk": {
      const ph = ctx.cycle(BEAT, 6.5);
      const hop = Math.max(0, Math.sin(ph));
      const land = 1 - hop;
      P.body.position.y = BODY_Y + hop * 0.06;
      P.body.scale.set(1 + 0.045 * land, 1 - 0.09 * land, 1 + 0.045 * land);
      P.body.rotation.set(0.08 * hop, 0, 0.05 * Math.sin(ph * 0.5));
      P.legL.rotation.x = 0.55 * Math.sin(ph);
      P.legR.rotation.x = 0.55 * Math.sin(ph + Math.PI);
      poseWings(
        P,
        0.55,
        0.12 * hop + 0.1 * Math.sin(ph + 0.5),
        0.08 * Math.sin(ph),
        0.1 * Math.sin(ph - 0.4),
      );
      P.head.rotation.set(0.1 - 0.12 * hop, 0.1 * Math.sin(t * 0.9), 0.05 * Math.sin(ph * 0.5));
      P.tail.rotation.set(0.2 + 0.15 * hop, 0.15 * Math.sin(ph), 0);
      break;
    }

    case "run": {
      const ph = ctx.cycle(BEAT, 8.5);
      const amp = 0.5 + 0.15 * ms;
      poseWings(
        P,
        0,
        Math.sin(ph) * amp + 0.06,
        Math.sin(ph - 0.55) * amp * 0.8,
        Math.sin(ph - 1.1) * amp * 0.95,
      );
      P.body.rotation.set(0.28, 0, 0.08 * Math.sin(t * 1.1));
      P.body.position.y = BODY_Y + Math.sin(ph - 0.95) * 0.05;
      P.head.rotation.set(-0.18, 0.06 * Math.sin(t * 1.3), -0.06 * Math.sin(t * 1.1));
      P.tail.rotation.set(-0.1 + 0.07 * Math.sin(ph - 1.3), 0, 0.05 * Math.sin(t * 1.1));
      P.legL.rotation.x = 1.15;
      P.legR.rotation.x = 1.15;
      break;
    }

    case "fly":
    case "swim": {
      const g = smooth((Math.sin(t * 0.33) + 1) * 0.7 - 0.2);
      // DIHEDRAL owns the resting V, so every action inherits it.
      const ph = ctx.cycle(BEAT, 3.6 + 2.6 * ms);
      const amp = (0.16 + 0.44 * (0.35 + 0.65 * ms)) * (1 - 0.82 * g);
      poseWings(
        P,
        0,
        Math.sin(ph) * amp + 0.18 * g,
        Math.sin(ph - 0.55) * amp * 0.8 + 0.1 * g,
        Math.sin(ph - 1.1) * amp * 0.95 + 0.05 * Math.sin(t * 7.3) * g,
      );
      // Barely any idle roll: 0.16 rad on a hovering owl reads as a broken mirror.
      const bank = Math.sin(t * 0.55) * (0.02 + 0.035 * g);
      const pitch = 0.16 + 0.12 * ms - 0.06 * Math.sin(ph - 0.9) * (1 - g);
      P.body.rotation.set(pitch, 0, bank);
      P.body.position.y =
        BODY_Y + Math.sin(ph - 0.95) * 0.05 * (1 - g) + Math.sin(t * 1.15) * 0.025 * g;
      P.head.rotation.set(-pitch * 0.55, Math.sin(t * 0.7) * 0.12, -bank * 0.7);
      P.tail.rotation.set(-0.12 + 0.07 * Math.sin(ph - 1.3) * (1 - g) + 0.05 * g, 0, bank * 0.5);
      P.legL.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.1);
      P.legR.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.3);
      break;
    }

    case "attack": {
      const wind = bump(at, 0.0, 0.3, 0.55);
      const strike = bump(at, 0.14, 0.55, 0.3);
      poseWings(
        P,
        0.15,
        0.5 * wind - 0.5 * strike + 0.05 * Math.sin(t * 18),
        0.35 * wind - 0.3 * strike,
        0.3 * wind - 0.35 * strike,
      );
      P.body.rotation.x = -0.15 * wind + 0.3 * strike;
      P.body.position.z = -0.05 * wind + 0.14 * strike;
      P.body.position.y = BODY_Y + 0.04 * wind - 0.03 * strike;
      P.head.rotation.x = -0.5 * wind + 0.85 * strike;
      P.head.position.z = HEAD_Z - 0.03 * wind + 0.1 * strike;
      P.head.position.y = HEAD_Y + 0.02 * wind - 0.04 * strike;
      P.tail.rotation.x = 0.15 + 0.3 * wind - 0.2 * strike;
      P.legL.rotation.x = 0.2 * wind - 0.7 * strike;
      P.legR.rotation.x = 0.2 * wind - 0.7 * strike;
      break;
    }

    case "cast": {
      const rise = smooth(at / 0.5);
      const shimmer = Math.sin(t * 9) * 0.06 * rise;
      poseWings(
        P,
        1 - rise,
        0.6 * rise + 0.1 * Math.sin(t * 2.6) * rise,
        0.35 * rise + shimmer,
        0.3 * rise + shimmer * 1.5,
      );
      P.body.position.y = BODY_Y + 0.1 * rise + 0.02 * Math.sin(t * 3.1);
      P.body.rotation.x = -0.18 * rise;
      P.head.rotation.set(-0.28 * rise + 0.04 * Math.sin(t * 3.1), 0.06 * Math.sin(t * 1.9), 0);
      P.tail.rotation.set(0.5 * rise, 0.04 * Math.sin(t * 3.1), 0);
      P.legL.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.4);
      P.legR.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.6);
      break;
    }

    case "special": {
      const gather = bump(at, 0, 0.5, 0.7);
      const slam = bump(at, 0.35, 0.8, 0.25);
      const after = smooth((at - 0.6) / 0.3);
      const shimmer = Math.sin(t * 16) * 0.12 * after * decay(at - 0.6, 1.2);
      poseWings(
        P,
        0,
        1.05 * gather - 1.0 * slam + 0.4 * after + shimmer,
        0.6 * gather - 0.6 * slam + 0.25 * after + shimmer * 1.3,
        0.5 * gather - 0.7 * slam + 0.2 * after + shimmer * 1.6,
      );
      P.body.position.y = BODY_Y - 0.06 * gather + 0.22 * slam + 0.08 * after;
      P.body.rotation.set(-0.2 * gather + 0.15 * slam, 0, 0.12 * Math.sin(at * 7) * slam);
      P.head.rotation.set(-0.35 * gather - 0.15 * after, 0, 0.1 * Math.sin(at * 7) * slam);
      P.tail.rotation.set(0.45 * gather + 0.3 * after, 0.08 * Math.sin(t * 5) * after, 0);
      P.legL.rotation.x = 0.3 * gather - 0.4 * slam;
      P.legR.rotation.x = 0.3 * gather - 0.4 * slam;
      break;
    }

    case "hurt": {
      const sh = decay(at, 6);
      const jit = Math.sin(at * 46);
      P.body.position.set(0.035 * jit * sh, BODY_Y - 0.03 * sh, -0.05 * sh);
      P.body.rotation.set(-0.12 * sh, 0, 0.08 * jit * sh);
      poseWings(P, 0.5, -0.3 * sh + 0.08 * jit * sh, -0.2 * sh, -0.15 * sh);
      P.head.rotation.set(-0.15 * sh, 0.25 * Math.sin(at * 30) * sh, 0.1 * jit * sh);
      P.tail.rotation.set(0.15 - 0.2 * sh, 0.1 * jit * sh, 0);
      P.legL.rotation.x = 0.3 * sh;
      P.legR.rotation.x = 0.3 * sh;
      break;
    }

    case "happy": {
      const ph = at * 9;
      const b = Math.abs(Math.sin(ph));
      const land = 1 - b;
      P.body.position.y = BODY_Y + 0.08 * b;
      P.body.scale.set(1 + 0.05 * land, 1 - 0.09 * land, 1 + 0.05 * land);
      P.body.rotation.set(-0.05 * b, 0.2 * Math.sin(at * 3.1), 0.05 * Math.sin(ph));
      poseWings(
        P,
        0.3,
        0.25 * b + 0.28 * Math.abs(Math.sin(at * 14)),
        0.2 * Math.sin(at * 14 - 0.4),
        0.25 * Math.sin(at * 14 - 0.8),
      );
      P.head.rotation.set(-0.1 * b, 0.3 * Math.sin(at * 2.2), 0.35 * Math.sin(at * 4.5));
      P.tail.rotation.set(0.3 + 0.2 * b, 0.35 * Math.sin(at * 8), 0);
      P.legL.rotation.x = 0.3 * Math.sin(at * 12);
      P.legR.rotation.x = 0.3 * Math.sin(at * 12 + Math.PI);
      break;
    }
  }
}

export const species: BeastSpecies = {
  id: "frostwing",
  nameKey: "beast.frostwing.name",
  element: "ice",
  locomotion: "flying",
  descriptionKey: "beast.frostwing.desc",
  baseStats: { maxHp: 44, attack: 13, defense: 7, speed: 6.5 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
