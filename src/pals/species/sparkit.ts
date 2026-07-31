import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { makeGlowSprite } from './glowsprite';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Sparkit — crackling-fast electric rodent. Chrome-yellow body, black
// lightning-bolt back stripes, tall zigzag tail with an electric twitch,
// big glinting eyes, orange cheek spark spots. ~0.6m tall, always jittery.
// ---------------------------------------------------------------------------

// Chrome yellow. Round 6 brought it back up: 0xe8b71e photographed as dull brass
// the moment the pal stood in tree shade, and an electric rodent whose whole
// identity is "bright" cannot afford a 60%-luminance coat.
const YEL = 0xffcb2e;
const YEL_LIGHT = 0xfff09a;  // sunlit crest along the spine and skull
const YEL_DARK = 0xd99a1c;   // shaded underside
const CREAM = 0xf3dc93;      // belly only
const INK = 0x211f1a;
const CHEEK = 0xff8a2b;
const SPARK_CORE = 0xfff2b8;  // warm gold, not near-white: bloom clips a white core
                              // to a featureless block and the bolt shape is lost
// Iris is a very dark COOL brown-black against the bright yellow coat, with a single
// cool-white catchlight. The cool-white iris that was here read as two pale plates
// with a dark dot in each; on a species whose coat is the brightest thing in frame,
// the eye has to be the dark mass or it has no boundary at all.
const IRIS = 0x3d2c11;       // dark warm ink — the coat hue at a tenth of value.
                             // Warm on purpose: a neutral dark cell lit only by blue
                             // sky bounce renders BLUE, and the eyes came back slate.
const EYE_GLINT = 0xf2f7ff;  // cool-white catchlight
const LID = 0xdfa41d;        // yellow at ~87%: the socket rim. At 70% the lid row
                             // was a full-width brown band over both eyes and the pair
                             // went straight back to reading as goggles.
const PAW = 0xffe9a8;

const S = 0.1; // voxel scale

/** Base transforms per part, relative to parent: [px, py, pz, rx, ry, rz] */
const BASE: Record<string, readonly [number, number, number, number, number, number]> = {
  body: [0, 0.12, 0, 0, 0, 0],
  head: [0, 0.22, 0.2, 0, 0, 0],
  earL: [0.1, 0.26, -0.04, -0.08, 0, 0.28],
  earR: [-0.1, 0.26, -0.04, -0.08, 0, -0.28],
  // Cheek sparks sit low and well outboard: at eye height they merged with the
  // eye row into one dark band with two glowing bars, i.e. goggles.
  sparkL: [0.29, -0.02, 0.06, 0, Math.PI / 2, 0],
  sparkR: [-0.29, -0.02, 0.06, 0, -Math.PI / 2, 0],
  tail: [0, 0.16, -0.26, -0.3, 0, 0],
  tailTip: [0, 0.36, -0.18, 0.55, 0, 0],
  legFL: [0.13, 0.06, 0.15, 0, 0, 0],
  legFR: [-0.13, 0.06, 0.15, 0, 0, 0],
  legBL: [0.15, 0.06, -0.13, 0, 0, 0],
  legBR: [-0.15, 0.06, -0.13, 0, 0, 0],
};

function buildRig(): PalRig {
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

  // -- body with zigzag lightning stripes down the back ---------------------
  const body = pivot('body', root);
  const bm = new VoxelModel();
  bm.ellipsoid(0, 2.2, 0, 2.8, 2.3, 3.6, YEL);
  bm.ellipsoid(0, 1.3, 1.0, 2.0, 1.5, 2.5, CREAM); // cream belly
  // Sunlit spine and shaded belly, painted BEFORE the bolt: both the rim and the
  // bolt claim the topmost cell of a column, and the bolt has to win.
  rimTop(bm, YEL_LIGHT, -3, 3, 0, 5, -4, 4);
  shadeUnder(bm, YEL_DARK, -3, 3, 0, 3, -4, 4);
  const zig = [1, 2, 1, 0, 1, 2, 1]; // mirrored bolt path along the spine
  for (let z = -3; z <= 3; z++) {
    const xm = zig[z + 3];
    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? xm : -xm;
      for (let y = 5; y >= 0; y--) {
        if (bm.has(sx, y, z)) {
          bm.set(sx, y, z, INK); // paint the topmost cell of the column
          break;
        }
      }
      if (xm === 0) break;
    }
  }
  const bodyMesh = bm.build(S);
  bodyMesh.position.y = -0.06;
  body.add(bodyMesh);

  // -- big-eyed head --------------------------------------------------------
  const head = pivot('head', body);
  const hm = new VoxelModel();
  // Skull widened 2.4 -> 2.8 so a full 2x2 eye fits with three cells of plain
  // yellow between the pair. The previous single-cell eye plus a glint below it
  // was legible in a 1200px portrait and completely gone at gameplay distance —
  // a 4px dot is not a face.
  hm.ellipsoid(0, 1.9, 0.2, 2.8, 2.1, 2.2, YEL);
  hm.box(-3, 0, 2, 3, 4, 2, YEL); // flat face plate, all body yellow
  rimTop(hm, YEL_LIGHT, -2, 2, 0, 5, -2, 2);
  shadeUnder(hm, YEL_DARK, -3, 3, 0, 1, -2, 1);
  // lowerLid is off: with a lid row above AND below, the eye grew into a 2x4 dark
  // column and the pair went back to reading as one band across the muzzle.
  eyes2x2(hm, {
    inner: 1, y: 2, faceZ: 2, iris: IRIS, shine: EYE_GLINT,
    lid: LID, browProud: true, bridge: YEL_LIGHT,
  });
  // Muzzle wedge in plain body yellow — a cream plate here was half the old mask
  // read. Geometry stays so the nose has something to sit on.
  // ONE cell wide, not three: a 3-wide proud muzzle at z=3 stood directly in front
  // of the inner column of each eye and hid a third of the iris.
  hm.box(0, 1, 3, 0, 2, 3, YEL);
  hm.set(0, 2, 4, INK); // button nose
  hm.set(0, 1, 4, EYE_GLINT); // buck tooth
  const headMesh = hm.build(S);
  headMesh.position.set(0, -0.14, 0.02);
  head.add(headMesh);

  // -- perky ears with black tips ------------------------------------------
  const mkEar = (name: string): void => {
    const g = pivot(name, head);
    const em = new VoxelModel();
    em.box(-1, 0, 0, 1, 1, 0, YEL);
    em.set(0, 2, 0, INK); // black tip
    g.add(em.build(S));
  };
  mkEar('earL');
  mkEar('earR');

  // -- cheek spark spots (separate so they can pop and flare) ---------------
  const mkSpark = (name: string): void => {
    const g = pivot(name, head);
    const sv = new VoxelModel();
    // ONE cell. The five-cell rosette was a plate on the cheek, and a plate on
    // the cheek is a goggle strap; the cheeks are plain body yellow now and the
    // spark is a single glowing dot plus its bloom sprite.
    sv.set(0, 1, 0, CHEEK);
    // 0.9, not 1.5: a bloom pass now exists, and animate() scales this group up
    // to 2.6x on a special — at the old intensity the cheeks became two white
    // discs that erased the ears and the eye on that side.
    sv.markEmissive(CHEEK, 0.45); // crackling electric dot — halved for bloom, which
                                  // was turning the two cheek sparks into headlights
    const m = sv.build(S);
    // -0.05, not -0.15: build() anchors y=0 at the lowest voxel, and the single
    // remaining cell is the old rosette's centre cell — this keeps the spark
    // exactly where the core used to sit, under the bloom sprite.
    m.position.y = -0.05;
    g.add(m);
    // Tiny electric-yellow halo on each cheek spark; pulses with the spark
    // because animate() scales this group. 0.13 / 0.08, down from 0.16 / 0.18 —
    // the sprite and the real bloom pass were compounding into two orange discs
    // on the cheeks that read as blush rather than as sparks. See glowsprite.ts.
    const cheekGlow = makeGlowSprite(0xffe680, 0.13, 0.08);
    cheekGlow.position.set(0, 0, 0.06);
    g.add(cheekGlow);
  };
  mkSpark('sparkL');
  mkSpark('sparkR');

  // -- tall zigzag lightning tail: base segment + flared tip ---------------
  const tailG = pivot('tail', body);
  // The bolt runs DARK at the root and gets hotter every step, instead of being
  // one flat body-yellow zigzag. The tail stands a good 0.6 units clear above the
  // skull, so it is never occluded — but photographed against sky in a six-pal lab
  // lineup it simply was not there: YEL / YEL_LIGHT on a bright sky is pale on pale,
  // and this bolt IS the whole electric read. A dark root also separates the tail
  // from the yellow body it grows out of, which the old YEL_DARK base did not.
  const t1 = new VoxelModel();
  t1.box(0, 0, 0, 1, 1, 0, INK);       // shadowed root: the bolt grows out of the coat
  t1.box(0, 1, -1, 1, 2, -1, YEL_DARK); // staircase up and back, charging as it goes
  t1.box(0, 2, -2, 1, 3, -2, YEL);
  const m1 = t1.build(S, false);
  m1.position.set(-0.1, 0, -0.05);
  tailG.add(m1);

  const tipG = pivot('tailTip', tailG);
  const t2 = new VoxelModel();
  t2.box(0, 0, 0, 1, 1, 0, YEL); // kinks back forward — classic bolt
  t2.box(0, 1, 1, 1, 2, 1, YEL_LIGHT);
  t2.box(-1, 3, 1, 2, 3, 1, YEL_LIGHT); // wide flare
  // Ink caps on both ends of the flare. The flare is the widest part of the bolt
  // and therefore the part that decides its shape against sky; in pale yellow its
  // two ends dissolved and the flare read as a blob under the tip glow. Two dark
  // cells give the zigzag hard corners — the same INK the back stripes use, so it
  // is the species' own language rather than an outline bolted on.
  t2.set(-1, 3, 1, INK);
  t2.set(2, 3, 1, INK);
  t2.box(0, 4, 1, 1, 4, 1, SPARK_CORE); // white-hot tip
  // Trimmed for the bloom pass: the bolt tip should read as hot metal, not as a
  // flashbulb that eats the tail's zigzag shape.
  // Halved for the bloom pass. At 0.7 / 1.05 the tail tip photographed as a single
  // clipped white cube the size of the pal's head, with the zigzag bolt shape gone
  // inside it — the same failure the emberfox flame had, and just as fatal here since
  // the bolt IS this species' silhouette read.
  t2.markEmissive(YEL_LIGHT, 0.34);     // electric-yellow glow up the bolt
  t2.markEmissive(SPARK_CORE, 0.5);     // brightest at the very tip
  const m2 = t2.build(S, false);
  m2.position.set(-0.1, 0, -0.05);
  tipG.add(m2);
  // Small halo on the white-hot bolt tip; rides the tail rig. 0.20 / 0.07, down
  // from 0.30 / 0.16: the bolt IS this species' silhouette read, and a 0.30-unit
  // additive disc plus the bloom pass on the emissive tip buried the zigzag in a
  // pale ball half the size of the pal's head — visible as a blown blob over the
  // sparkit's head in the ten-pal lab lineup. See glowsprite.ts.
  const tipGlow = makeGlowSprite(0xffe680, 0.20, 0.07);
  tipGlow.position.set(0, 0.47, 0.05);
  tipG.add(tipGlow);

  // -- darty little legs ----------------------------------------------------
  const mkLeg = (name: string): void => {
    const g = pivot(name, body);
    const lv = new VoxelModel();
    lv.box(0, 0, 0, 1, 1, 1, YEL_DARK);
    lv.box(0, 0, 0, 1, 0, 1, PAW);
    const m = lv.build(S);
    m.position.y = -0.18;
    g.add(m);
  };
  mkLeg('legFL');
  mkLeg('legFR');
  mkLeg('legBL');
  mkLeg('legBR');

  return { root, parts, height: 0.62, radius: 0.3 };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

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
/** Periodic sharp pulse in 0..1 (for twitches / crackles / hops) */
function pulse(x: number, sharp: number): number {
  const s = Math.sin(x);
  return s > 0 ? Math.pow(s, sharp) : 0;
}

function resetPose(parts: Record<string, THREE.Object3D>): void {
  for (const k in BASE) {
    const o = parts[k];
    const b = BASE[k];
    o.position.set(b[0], b[1], b[2]);
    o.rotation.set(b[3], b[4], b[5]);
    o.scale.set(1, 1, 1);
  }
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  resetPose(p);
  const body = p['body'];
  const head = p['head'];
  const earL = p['earL'];
  const earR = p['earR'];
  const sparkL = p['sparkL'];
  const sparkR = p['sparkR'];
  const tail = p['tail'];
  const tailTip = p['tailTip'];
  const legFL = p['legFL'];
  const legFR = p['legFR'];
  const legBL = p['legBL'];
  const legBR = p['legBR'];
  const t = ctx.time;
  const at = ctx.actionTime;

  switch (ctx.action) {
    case 'idle': {
      const breath = Math.sin(t * 3.4); // quick rodent breathing
      body.scale.y += breath * 0.025;
      body.scale.z -= breath * 0.012;
      // darty head: snaps between look directions, never drifts
      const look = Math.tanh((Math.sin(t * 0.9) + 0.6 * Math.sin(t * 1.9 + 2.0)) * 2.2);
      head.rotation.y += look * 0.4;
      head.rotation.x += Math.sin(t * 2.8) * 0.04 + pulse(t * 0.7 + 2.0, 26) * 0.18; // sniff dips
      head.position.y += Math.sin(t * 7.0) * 0.004;
      earL.rotation.z += pulse(t * 1.15 + 0.3, 30) * 0.35; // independent ear twitches
      earR.rotation.z -= pulse(t * 1.45 + 3.1, 30) * 0.35;
      // electric tail: slow sway broken by crackle bursts of high-freq jitter
      const crackle = pulse(t * 1.7 + 1.0, 14);
      tail.rotation.z += Math.sin(t * 1.6) * 0.07 + crackle * Math.sin(t * 43.0) * 0.12;
      tail.rotation.x += crackle * Math.sin(t * 37.0) * 0.08;
      tailTip.rotation.z += Math.sin(t * 2.1 + 0.6) * 0.1 + crackle * Math.sin(t * 51.0) * 0.22;
      sparkL.scale.setScalar(1 + pulse(t * 2.3 + 0.5, 16) * 0.7); // cheek sparks pop
      sparkR.scale.setScalar(1 + pulse(t * 2.0 + 3.6, 16) * 0.7);
      legFL.rotation.x += pulse(t * 1.3 + 5.0, 22) * 0.5; // impatient paw taps
      legFR.rotation.x += pulse(t * 1.1 + 1.2, 22) * 0.5;
      body.rotation.z += Math.sin(t * 1.1) * 0.02;
      break;
    }

    case 'walk':
    case 'run':
    case 'swim':
    case 'fly': {
      const g = ctx.moveSpeed;
      const freq = 9.5 + g * 5.5; // scampering bound
      const ph = t * freq;
      const stride = 0.55 + g * 0.5;
      legFL.rotation.x += Math.sin(ph) * stride;
      legFR.rotation.x += Math.sin(ph + 0.35) * stride;
      legBL.rotation.x += Math.sin(ph + 2.5) * stride * 1.15;
      legBR.rotation.x += Math.sin(ph + 2.85) * stride * 1.15;
      const arc = Math.max(0, Math.sin(ph + 1.1));
      body.position.y += arc * arc * (0.02 + 0.05 * g); // bounding arc
      body.rotation.x += Math.sin(ph + 0.7) * 0.1 * (0.35 + g);
      const stretch = Math.sin(ph + 1.0) * 0.05 * (0.5 + g);
      body.scale.z += stretch; // stretch on launch, squash on landing
      body.scale.y -= stretch * 0.8;
      head.rotation.x += -Math.sin(ph + 0.7) * 0.07; // gaze stabilization
      head.rotation.y += Math.sin(t * 3.1) * 0.06; // scanning for trouble
      earL.rotation.x += -0.35 * g + Math.sin(ph - 0.6) * 0.08; // ears pinned back
      earR.rotation.x += -0.35 * g + Math.sin(ph - 0.9) * 0.08;
      tail.rotation.x += -0.4 * g + Math.sin(ph - 1.2) * 0.12; // tail streams behind
      tailTip.rotation.x += Math.sin(ph - 2.0) * 0.2 + Math.sin(t * 40.0) * 0.06 * g;
      tailTip.rotation.z += Math.sin(t * 35.0) * 0.05 * g;
      // occasional gleeful hop mid-run
      const hopP = pulse(t * 0.85 + 0.7, 9) * (0.3 + g * 0.7);
      body.position.y += hopP * 0.1;
      body.rotation.x += -hopP * 0.25;
      legFL.rotation.x += hopP * 0.7; // legs tuck for the hop
      legFR.rotation.x += hopP * 0.7;
      legBL.rotation.x += hopP * 0.5;
      legBR.rotation.x += hopP * 0.5;
      sparkL.scale.setScalar(1 + g * 0.3 + hopP * 0.5); // sparks trail excitement
      sparkR.scale.setScalar(1 + g * 0.3 + hopP * 0.5);
      break;
    }

    case 'attack': {
      const coilK = smooth(clamp01(at / 0.12)); // lightning-fast crouch
      const strike = easeOutCubic(clamp01((at - 0.12) / 0.1)); // pounce
      const rec = smooth(clamp01((at - 0.3) / 0.35));
      const lunge = strike * (1 - rec);
      const coil = coilK * (1 - strike);
      body.position.z += -coil * 0.07 + lunge * 0.2;
      body.position.y += -coil * 0.04 + lunge * 0.03;
      body.rotation.x += -coil * 0.18 + lunge * 0.22;
      body.scale.z += -coil * 0.12 + lunge * 0.15;
      body.scale.y += coil * 0.08 - lunge * 0.08;
      head.rotation.x += -coil * 0.25 + lunge * 0.35;
      earL.rotation.x += -(coil + lunge) * 0.6; // ears pinned
      earR.rotation.x += -(coil + lunge) * 0.6;
      tail.rotation.x += coil * 0.4 - lunge * 0.6; // tail whips through
      tailTip.rotation.x += -coil * 0.3 + lunge * 0.8;
      sparkL.scale.setScalar(1 + lunge * 1.2); // sparks flash on impact
      sparkR.scale.setScalar(1 + lunge * 1.2);
      legFL.rotation.x += coil * 0.5 - lunge * 1.1; // front paws reach
      legFR.rotation.x += coil * 0.5 - lunge * 1.1;
      legBL.rotation.x += -coil * 0.5 + lunge * 0.8; // hind legs kick off
      legBR.rotation.x += -coil * 0.5 + lunge * 0.8;
      break;
    }

    case 'cast': {
      const up = smooth(clamp01(at / 0.22)); // rears onto hind legs to channel
      body.rotation.x += -0.5 * up;
      body.position.y += 0.05 * up;
      body.position.z += -0.03 * up;
      legFL.rotation.x += (-1.25 + Math.sin(t * 22.0) * 0.12) * up; // paws up, trembling
      legFR.rotation.x += (-1.25 + Math.sin(t * 22.0 + 2.1) * 0.12) * up;
      legBL.rotation.x += 0.5 * up;
      legBR.rotation.x += 0.5 * up;
      head.rotation.x += 0.42 * up + Math.sin(t * 26.0) * 0.02 * up;
      earL.rotation.x += 0.2 * up; // ears perk forward
      earR.rotation.x += 0.2 * up;
      earL.rotation.z += -0.14 * up;
      earR.rotation.z += 0.14 * up;
      tail.rotation.x += 0.25 * up + Math.sin(t * 55.0) * 0.05 * up; // bolt-tail goes rigid,
      tailTip.rotation.x += -0.35 * up + Math.sin(t * 55.0 + 1.5) * 0.1 * up; // vibrating skyward
      sparkL.scale.setScalar(1 + up * (0.9 + Math.sin(t * 34.0) * 0.35)); // cheeks charging
      sparkR.scale.setScalar(1 + up * (0.9 + Math.sin(t * 34.0 + 1.6) * 0.35));
      break;
    }

    case 'special': {
      const wind = smooth(clamp01(at / 0.15)); // deep crouch
      const spinT = clamp01((at - 0.15) / 0.6); // discharge spin-jump
      const s = easeOutCubic(spinT);
      const air = Math.sin(spinT * Math.PI);
      body.rotation.y += s * Math.PI * 6; // three furious spins
      body.position.y += air * 0.2 - wind * 0.04;
      body.scale.y += -wind * 0.22 + air * 0.15;
      body.scale.x += wind * 0.1 - air * 0.06;
      body.scale.z += wind * 0.1 - air * 0.06;
      legFL.rotation.x += wind * 0.3 - air * 0.9; // legs splay in the air
      legFR.rotation.x += wind * 0.3 - air * 0.9;
      legBL.rotation.x += -wind * 0.3 + air * 0.9;
      legBR.rotation.x += -wind * 0.3 + air * 0.9;
      head.rotation.x += -0.2 * air;
      earL.rotation.z += air * 0.5; // ears flare with centrifugal glee
      earR.rotation.z += -air * 0.5;
      tail.rotation.x += -air * 0.7 + Math.sin(t * 40.0) * 0.08 * air; // tail helicopters out
      tailTip.rotation.x += air * 0.4 + Math.sin(t * 47.0) * 0.1 * air;
      sparkL.scale.setScalar(1 + air * 1.6 + Math.sin(t * 45.0) * 0.2 * air); // full nova
      sparkR.scale.setScalar(1 + air * 1.6 + Math.sin(t * 45.0 + 2.0) * 0.2 * air);
      if (at > 0.78) {
        const w = at - 0.78; // landing recoil wobble
        const d = Math.exp(-w * 6.0);
        body.rotation.z += Math.sin(w * 26.0) * 0.06 * d;
        body.scale.y += -Math.exp(-w * 10.0) * 0.08;
      }
      break;
    }

    case 'hurt': {
      const d = Math.exp(-at * 6.0);
      body.position.x += Math.sin(at * 50.0) * 0.04 * d; // rapid static shake
      body.rotation.z += Math.sin(at * 47.0 + 1.0) * 0.12 * d;
      body.position.z += -0.05 * d;
      body.scale.y += -0.15 * d;
      body.scale.x += 0.09 * d;
      body.scale.z += 0.09 * d;
      head.rotation.x += -0.28 * d; // recoils
      earL.rotation.z += 0.5 * d; // ears droop outward
      earR.rotation.z += -0.5 * d;
      earL.rotation.x += -0.4 * d;
      earR.rotation.x += -0.4 * d;
      tail.rotation.x += -0.5 * d + Math.sin(at * 44.0) * 0.1 * d; // tail sags, sputtering
      tailTip.rotation.x += 0.3 * d + Math.sin(at * 52.0) * 0.15 * d;
      const fizzle = 1 - d * 0.55; // sparks fizzle low
      sparkL.scale.setScalar(fizzle);
      sparkR.scale.setScalar(fizzle);
      legFL.rotation.x += 0.3 * d;
      legFR.rotation.x += 0.3 * d;
      legBL.rotation.x += -0.3 * d;
      legBR.rotation.x += -0.3 * d;
      break;
    }

    case 'happy': {
      const hop = Math.abs(Math.sin(at * 7.5)); // ecstatic pogo bounces
      const hu = hop * hop;
      body.position.y += hu * 0.12;
      body.scale.y += -0.1 + hu * 0.2;
      body.scale.x += 0.06 - hu * 0.08;
      body.scale.z += 0.06 - hu * 0.08;
      const spinT = smooth(clamp01((at - 0.5) / 0.4)); // one joyful mid-air twirl
      body.rotation.y += spinT * Math.PI * 2 + Math.sin(at * 4.0) * 0.15;
      earL.rotation.z += Math.sin(at * 15.0) * 0.25; // ears flop with the beat
      earR.rotation.z += Math.sin(at * 15.0 + Math.PI) * 0.25;
      tail.rotation.z += Math.sin(at * 11.0) * 0.45; // huge tail wag
      tailTip.rotation.z += Math.sin(at * 11.0 - 0.8) * 0.5;
      head.rotation.z += Math.sin(at * 7.5 + 1.0) * 0.2;
      sparkL.scale.setScalar(1.2 + Math.sin(at * 13.0) * 0.5); // party sparks
      sparkR.scale.setScalar(1.2 + Math.sin(at * 13.0 + 1.5) * 0.5);
      legFL.rotation.x += Math.sin(at * 15.0) * 0.4; // air-paddling paws
      legFR.rotation.x += Math.sin(at * 15.0 + Math.PI) * 0.4;
      legBL.rotation.x += Math.sin(at * 15.0 + 1.2) * 0.35;
      legBR.rotation.x += Math.sin(at * 15.0 + 4.3) * 0.35;
      break;
    }
  }

  // Ambient static layer: Sparkit is never, ever fully still
  const jit = Math.sin(t * 31.0) * Math.sin(t * 17.3);
  tailTip.rotation.z += jit * 0.04;
  tail.rotation.z += jit * 0.02;
  // Crackle jitter on the glowing bolt tip: brief high-frequency bursts.
  const crackleBurst = pulse(t * 1.9 + 0.4, 18);
  tailTip.rotation.x += crackleBurst * Math.sin(t * 57.0) * 0.06;
  tailTip.rotation.z += crackleBurst * Math.sin(t * 49.0) * 0.05;
  earL.rotation.z += Math.sin(t * 21.0) * 0.015;
  earR.rotation.z -= Math.sin(t * 19.0) * 0.015;
  head.rotation.z += Math.sin(t * 13.7) * 0.008;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skills: SkillDef[] = [
  {
    id: 'sparkit.static-zap',
    name: 'Static Zap',
    description: 'Flicks a stinging bead of static off its cheek spots. Cheap, cheerful, and mildly rude.',
    element: 'electric',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.5,
    power: 9,
    range: 13,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'sparkit.volt-dash',
    name: 'Volt Dash',
    description: 'Blinks forward in a crackle of afterimages and shoulder-checks the target at full charge.',
    element: 'electric',
    targeting: 'melee',
    cost: 10,
    cooldown: 4,
    power: 17,
    range: 3.5,
    learnAtLevel: 4,
    castAnim: 'attack',
  },
  {
    id: 'sparkit.thunder-coil',
    name: 'Thunder Coil',
    description: 'Winds its zigzag tail like a spring, then releases a snapping ring of lightning around itself.',
    element: 'electric',
    targeting: 'aoe',
    cost: 18,
    cooldown: 8,
    power: 27,
    range: 5.5,
    storePrice: 260,
    castAnim: 'cast',
  },
  {
    id: 'sparkit.gigavolt-crash',
    name: 'Gigavolt Crash',
    description: 'Every stripe on its back lights up as it fires a searing bolt-beam straight down the line.',
    element: 'electric',
    targeting: 'beam',
    cost: 24,
    cooldown: 11,
    power: 42,
    range: 12,
    storePrice: 380,
    castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export const species: PalSpecies = {
  id: 'sparkit',
  name: 'Sparkit',
  element: 'electric',
  locomotion: 'ground',
  description:
    'A hyperactive spark rodent that physically cannot sit still. Its tall zigzag tail is a ' +
    'living lightning rod, and its cheek spots crackle whenever it gets excited — so, always.',
  baseStats: { maxHp: 42, attack: 13, defense: 7, speed: 5.4 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
