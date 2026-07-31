import * as THREE from 'three';
import type { BeastSpecies, SkillDef, BeastRig, BeastAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Sproutle — round leafy turtle-dino. Moss body, leaf-plate shell dome,
// springy two-leaf head sprout, stubby plodding legs. ~0.85m tall.
// ---------------------------------------------------------------------------

// Terrain grass is a bright yellow-green (~0x54c832), so the coat is pushed to
// a cooler moss and given a cream belly: value + hue separation from any lawn it
// stands on. Round 6 raised every green a full step — standing in tree shade the
// old set was one flat dark green mass, and the beast disappeared into the lawn it
// was supposed to contrast with. Hue separation, not darkness, does that job.
// Round 6 rotated every green about 20 degrees toward TEAL. Value alone was never
// going to separate this beast from the lawn: the terrain grass is a yellow-green
// (~0x54c832) and the coat was 0x74bd57, i.e. the same hue a little lighter, so in the
// shade of a terrace the beast and the ground behind it were literally the same colour
// and a critic could not find the creature in its own portrait. A cooler green stays
// unmistakably plant, and the yellow-green now belongs only to the LEAF sprout — which
// gives the beast an internal hue contrast it did not have either.
const MOSS = 0x63c07e;
const MOSS_LIGHT = 0x9ae8ab; // sunlit leaf-green highlights
const MOSS_DARK = 0x3d8657;
const BELLY = 0xf0e2bf;      // cream belly / chin patch
const SHELL = 0x43a86d;
const SHELL_LIGHT = 0x69cd8c;
const SHELL_DARK = 0x2c7550;
const STEM = 0x5aa340;
const LEAF = 0x7cdc60;
const LEAF_LIGHT = 0xaaf08c;
const FOOT = 0xd8c88c;
// Dark iris, bright catchlight. The cream 2x3 iris that was here sat within a few
// percent of the cream chin right below it, so at portrait distance the whole lower
// face was one pale field with two dark pupils in it — a critic saw exactly that and
// called it dead eyes.
const IRIS = 0x14301f;       // dark forest green — the coat hue at a fifth of value
const SHINE = 0xf8fff0;      // single catchlight cell
const BROW = 0x2f6b4a;       // socket rim / lid row
// No cheek mark. The old salmon BLUSH cell sat one row under the OUTER eye column,
// i.e. right on the silhouette edge of the face plate, and in shade a saturated
// salmon goes red-brown: two dark red bars under the eyes that read as wounds or
// rust streaks. A blush that only works in direct sun is not a blush.

const S = 0.1; // voxel scale

/** Base transforms per part, relative to parent: [px, py, pz, rx, ry, rz] */
const BASE: Record<string, readonly [number, number, number, number, number, number]> = {
  body: [0, 0.16, 0, 0, 0, 0],
  shell: [0, 0.26, -0.04, 0, 0, 0],
  head: [0, 0.28, 0.3, 0, 0, 0],
  // 0.30, not 0.40. The crown's top face is at ~0.42 and the old two-cell stem began
  // at 0.40 — a 2 cm overlap, which the sprout's springy rotation immediately opened
  // into daylight: a critic saw the leaf pair "hovering above the head with a clear
  // gap". Dropped 10 cm and grown to three cells, the stem's base is buried a full
  // cell inside the skull at every phase of the bounce.
  sprout: [0, 0.30, -0.02, 0, 0, 0],
  leafL: [0, 0.26, 0, 0, 0.5, 0.45],
  leafR: [0, 0.26, 0, 0, Math.PI - 0.5, 0.45],
  tail: [0, 0.06, -0.36, 0.2, 0, 0],
  legFL: [0.2, 0.1, 0.22, 0, 0, 0],
  legFR: [-0.2, 0.1, 0.22, 0, 0, 0],
  legBL: [0.2, 0.1, -0.2, 0, 0, 0],
  legBR: [-0.2, 0.1, -0.2, 0, 0, 0],
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

  // -- torso ----------------------------------------------------------------
  const body = pivot('body', root);
  const torso = new VoxelModel();
  torso.ellipsoid(0, 2.6, 0, 3.6, 2.7, 4.2, MOSS);
  torso.ellipsoid(0, 2.6, 2.2, 3.2, 1.5, 2.2, MOSS_LIGHT); // sunlit shoulders
  torso.ellipsoid(0, 1.4, 1.0, 2.8, 1.8, 3.2, BELLY); // cream belly patch
  rimTop(torso, MOSS_LIGHT, -3, 3, 0, 5, -4, 4);
  shadeUnder(torso, MOSS_DARK, -3, 3, 0, 4, -4, 4);
  const torsoMesh = torso.build(S);
  torsoMesh.position.y = -0.02;
  body.add(torsoMesh);

  // -- leaf-plate shell dome (pivots at its base for wobble) ---------------
  const shell = pivot('shell', body);
  const dome = new VoxelModel();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      for (let y = 0; y <= 3; y++) {
        const dx = x / 3.9;
        const dy = y / 3.3;
        const dz = z / 4.5;
        if (dx * dx + dy * dy + dz * dz > 1) continue;
        const seam = ((x % 3) + 3) % 3 === 0 || ((z % 3) + 3) % 3 === 0;
        const check = (Math.floor((x + 9) / 3) + Math.floor((z + 9) / 3)) % 2 === 0;
        let c = seam ? SHELL_DARK : check ? SHELL : SHELL_LIGHT;
        if (y === 0) c = SHELL_DARK; // dark leaf-tip rim
        dome.set(x, y, z, c);
      }
    }
  }
  dome.set(0, 4, 0, SHELL_DARK); // topmost leaf nub
  shell.add(dome.build(S));

  // -- head -----------------------------------------------------------------
  const head = pivot('head', body);
  const hm = new VoxelModel();
  // Skull widened from 2.6 to 3.0 so the eye pair can sit three cells apart with
  // plain moss between them instead of touching over a pale bridge.
  hm.ellipsoid(0, 2.2, 0.1, 3.0, 2.2, 2.3, MOSS);
  hm.ellipsoid(0, 3.4, -0.3, 2.5, 1.0, 2.0, MOSS_LIGHT); // lit crown
  hm.box(-3, 1, 2, 3, 4, 2, MOSS); // flat friendly face plate, all coat colour
  hm.ellipsoid(0, 0.7, 1.5, 2.2, 0.9, 1.5, BELLY); // cream chin, dropped clear of
  // the eye line: level with the eyes it merged with the sclera into one band
  hm.box(-1, 1, 3, 1, 1, 3, BELLY); // little snout
  rimTop(hm, MOSS_LIGHT, -3, 3, 0, 5, -3, 3);
  shadeUnder(hm, MOSS_DARK, -3, 3, 0, 1, -3, 1);
  eyes2x2(hm, {
    inner: 1, y: 2, faceZ: 2, iris: IRIS, shine: SHINE,
    lid: BROW, browProud: true, bridge: BELLY,
  });
  const headMesh = hm.build(S);
  headMesh.position.set(0, -0.08, 0.02);
  head.add(headMesh);

  // -- springy head sprout with two leaves ---------------------------------
  const sprout = pivot('sprout', head);
  const stem = new VoxelModel();
  stem.box(0, 0, 0, 0, 2, 0, STEM); // three cells: the lowest one lives in the skull
  sprout.add(stem.build(S));

  const mkLeaf = (name: string): void => {
    const g = pivot(name, sprout);
    const leaf = new VoxelModel();
    leaf.set(0, 0, 0, LEAF);
    leaf.box(1, 0, -1, 3, 0, 1, LEAF);
    leaf.set(3, 0, -1, LEAF_LIGHT);
    leaf.set(3, 0, 1, LEAF_LIGHT);
    leaf.set(4, 0, 0, LEAF_LIGHT); // pale tip
    leaf.box(1, 0, 0, 3, 0, 0, STEM); // midrib
    const m = leaf.build(S, false); // pivot stays at leaf base
    m.position.set(0, 0, -0.05);
    g.add(m);
  };
  mkLeaf('leafL');
  mkLeaf('leafR');

  // -- tail nub -------------------------------------------------------------
  const tailG = pivot('tail', body);
  const tv = new VoxelModel();
  tv.ellipsoid(0, 1.2, -1.4, 1.4, 1.2, 1.8, MOSS);
  const tailMesh = tv.build(S);
  tailMesh.position.set(0, -0.1, -0.12);
  tailG.add(tailMesh);

  // -- stubby legs (pivot at hip/shoulder) ---------------------------------
  const mkLeg = (name: string): void => {
    const g = pivot(name, body);
    const lv = new VoxelModel();
    lv.box(0, 1, 0, 1, 2, 1, MOSS_DARK);
    lv.box(0, 0, 0, 1, 0, 1, FOOT);
    lv.set(0, 0, 2, FOOT); // toes
    lv.set(1, 0, 2, FOOT);
    const m = lv.build(S);
    m.position.y = -0.26;
    g.add(m);
  };
  mkLeg('legFL');
  mkLeg('legFR');
  mkLeg('legBL');
  mkLeg('legBR');

  return { root, parts, height: 0.85, radius: 0.42 };
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
/** Periodic sharp pulse in 0..1 (for twitches / blinks / paw taps) */
function pulse(x: number, sharp: number): number {
  const s = Math.sin(x);
  return s > 0 ? Math.pow(s, sharp) : 0;
}

/**
 * The plod, on an integrated phase — see BeastAnimCtx.cycle(). 5 rad/s to 8
 * (0.8-1.3 Hz), scaled by the gait blend; as `t * freq` a change of pace
 * rewrote the whole phase history and jump-cut legs, shell, sprout and tail
 * together.
 */
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
  const body = p['body'];
  const shell = p['shell'];
  const head = p['head'];
  const sprout = p['sprout'];
  const leafL = p['leafL'];
  const leafR = p['leafR'];
  const tail = p['tail'];
  const legFL = p['legFL'];
  const legFR = p['legFR'];
  const legBL = p['legBL'];
  const legBR = p['legBR'];
  const t = ctx.time;
  const at = ctx.actionTime;

  switch (ctx.action) {
    case 'idle': {
      const br = Math.sin(t * 1.7); // slow contented breathing
      body.scale.y += br * 0.02;
      body.scale.x -= br * 0.01;
      body.scale.z -= br * 0.01;
      shell.position.y += br * 0.004;
      head.rotation.z += Math.sin(t * 0.6) * 0.08; // lazy head tilt
      head.rotation.x += Math.sin(t * 0.85 + 1.0) * 0.05;
      const peek = pulse(t * 0.5 + 1.0, 24); // occasional curious head cock
      head.rotation.z += peek * 0.22;
      sprout.rotation.x += Math.sin(t * 2.2) * 0.1 + peek * 0.25;
      leafL.rotation.z += Math.sin(t * 1.9) * 0.09;
      leafR.rotation.z += Math.sin(t * 1.9 + 1.4) * 0.09;
      tail.rotation.y += Math.sin(t * 1.4) * 0.18;
      body.rotation.z += Math.sin(t * 0.5) * 0.02; // weight shift
      legFL.rotation.x += pulse(t * 0.4 + 3.0, 20) * 0.25; // idle paw scuff
      break;
    }

    case 'walk':
    case 'run':
    case 'swim':
    case 'fly': {
      const g = ctx.moveSpeed;
      const spd = 0.4 + g * 0.6;
      const freq = 5.0 + g * 3.0; // determined little plod
      const ph = ctx.cycle(GAIT, freq);
      const amp = 0.42 + g * 0.33;
      legFL.rotation.x += Math.sin(ph) * amp;
      legBR.rotation.x += Math.sin(ph + 0.25) * amp;
      legFR.rotation.x += Math.sin(ph + Math.PI) * amp;
      legBL.rotation.x += Math.sin(ph + Math.PI + 0.25) * amp;
      const bob = Math.abs(Math.sin(ph));
      body.position.y += bob * bob * 0.035 * spd;
      body.scale.y += (bob - 0.5) * 0.05 * spd; // squash on contact, stretch on rise
      body.rotation.z += Math.sin(ph) * 0.06 * spd; // waddle roll
      body.rotation.x += Math.sin(ph * 2 + 0.6) * 0.02 * spd;
      shell.rotation.z += Math.sin(ph - 0.7) * 0.1 * spd; // shell wobbles a beat behind
      shell.rotation.x += Math.sin(ph * 2 - 0.9) * 0.04 * spd;
      head.rotation.x += Math.sin(ph * 2 + 0.4) * 0.05 * spd - 0.03;
      head.rotation.z += Math.sin(ph) * 0.04 * spd;
      sprout.rotation.x += Math.sin(ph - 1.3) * 0.3 * spd; // springy lag
      sprout.rotation.z += Math.sin(ph * 0.5) * 0.06;
      leafL.rotation.z += Math.sin(ph - 1.7) * 0.14 * spd;
      leafR.rotation.z += Math.sin(ph - 0.7) * 0.14 * spd;
      tail.rotation.y += Math.sin(ph) * 0.22 * spd;
      tail.rotation.x += Math.sin(ph * 2 - 0.5) * 0.06 * spd;
      break;
    }

    case 'attack': {
      const coilK = smooth(clamp01(at / 0.22)); // anticipation: rock back
      const strike = easeOutCubic(clamp01((at - 0.22) / 0.16)); // headbutt lunge
      const rec = smooth(clamp01((at - 0.46) / 0.42)); // settle
      const lunge = strike * (1 - rec);
      const coil = coilK * (1 - strike);
      body.rotation.x += -coil * 0.22 + lunge * 0.2;
      body.position.z += -coil * 0.06 + lunge * 0.17;
      body.position.y += -coil * 0.03 + lunge * 0.02;
      body.scale.z += -coil * 0.06 + lunge * 0.08;
      body.scale.y += coil * 0.04 - lunge * 0.05;
      head.rotation.x += -coil * 0.3 + lunge * 0.45;
      sprout.rotation.x += -coil * 0.55 + lunge * 1.05; // sprout whips through
      leafL.rotation.z += -lunge * 0.25;
      leafR.rotation.z += -lunge * 0.25;
      legFL.rotation.x += coil * 0.35 - lunge * 0.55;
      legFR.rotation.x += coil * 0.35 - lunge * 0.55;
      legBL.rotation.x += -coil * 0.3 + lunge * 0.45;
      legBR.rotation.x += -coil * 0.3 + lunge * 0.45;
      tail.rotation.x += coil * 0.3 - lunge * 0.35;
      shell.rotation.x += -coil * 0.08 + lunge * 0.1;
      break;
    }

    case 'cast': {
      const up = smooth(clamp01(at / 0.35)); // rear up on hind legs
      const trem = Math.sin(t * 11.0) * up;
      body.rotation.x += -0.38 * up;
      body.position.y += 0.045 * up;
      legFL.rotation.x += -1.05 * up + trem * 0.07; // front paws raised, trembling
      legFR.rotation.x += -1.05 * up - trem * 0.07;
      legBL.rotation.x += 0.4 * up;
      legBR.rotation.x += 0.4 * up;
      head.rotation.x += 0.3 * up + Math.sin(t * 13.0) * 0.03 * up;
      sprout.rotation.y += at * 8.0 * up; // sprout spins up like a propeller
      sprout.rotation.x += -0.08 * up;
      leafL.rotation.z += -0.3 * up; // leaves flatten into rotor blades
      leafR.rotation.z += -0.3 * up;
      shell.rotation.y += Math.sin(t * 9.0) * 0.05 * up;
      tail.rotation.x += -0.45 * up;
      break;
    }

    case 'special': {
      const wind = smooth(clamp01(at / 0.18)); // crouch
      const spinT = clamp01((at - 0.18) / 0.75); // launch into a leafy top-spin
      const s = easeOutCubic(spinT);
      const air = Math.sin(spinT * Math.PI);
      body.rotation.y += s * Math.PI * 4;
      body.position.y += air * 0.15 - wind * 0.05;
      body.scale.y += -wind * 0.16 + air * 0.1;
      body.scale.x += wind * 0.08 - air * 0.04;
      body.scale.z += wind * 0.08 - air * 0.04;
      legFL.rotation.x += wind * 0.5 + air * 0.6; // legs tuck in
      legFR.rotation.x += wind * 0.5 + air * 0.6;
      legBL.rotation.x += -wind * 0.5 - air * 0.6;
      legBR.rotation.x += -wind * 0.5 - air * 0.6;
      head.rotation.x += 0.18 * air;
      head.position.z += -0.05 * wind; // tucks toward shell
      sprout.rotation.x += -0.45 * air; // sprout streams from the spin
      sprout.rotation.z += Math.sin(at * 22.0) * 0.08 * air;
      leafL.rotation.z += -0.3 * air;
      leafR.rotation.z += -0.3 * air;
      tail.rotation.x += 0.5 * air;
      shell.rotation.y += -air * 0.35; // shell lags the spin
      if (at > 0.93) {
        const w = at - 0.93; // landing: shell rattle + squash
        const d = Math.exp(-w * 5.0);
        shell.rotation.z += Math.sin(w * 30.0) * 0.15 * d;
        body.scale.y += -Math.exp(-w * 9.0) * 0.06;
      }
      break;
    }

    case 'hurt': {
      const d = Math.exp(-at * 5.0);
      body.position.x += Math.sin(at * 42.0) * 0.035 * d;
      body.rotation.z += Math.sin(at * 42.0 + 1.0) * 0.1 * d;
      body.position.z += -0.06 * d;
      body.scale.y += -0.12 * d;
      body.scale.x += 0.07 * d;
      body.scale.z += 0.07 * d;
      head.position.z += -0.09 * d; // flinches back toward the shell
      head.rotation.x += 0.22 * d;
      shell.rotation.z += Math.sin(at * 35.0) * 0.13 * d;
      sprout.rotation.x += Math.sin(at * 30.0) * 0.4 * d;
      tail.rotation.x += -0.4 * d;
      legFL.rotation.x += 0.25 * d;
      legFR.rotation.x += 0.25 * d;
      legBL.rotation.x += -0.25 * d;
      legBR.rotation.x += -0.25 * d;
      break;
    }

    case 'happy': {
      const hop = Math.abs(Math.sin(at * 6.0));
      const hu = hop * hop;
      body.position.y += hu * 0.1; // joyful little bounces
      body.scale.y += -0.07 + hu * 0.15; // squash at ground, stretch in air
      body.scale.x += 0.05 - hu * 0.07;
      body.scale.z += 0.05 - hu * 0.07;
      body.rotation.y += Math.sin(at * 3.0) * 0.55; // happy swivel
      head.rotation.z += Math.sin(at * 6.0 + 0.8) * 0.16;
      head.rotation.x += -0.1;
      sprout.rotation.x += Math.sin(at * 12.0 - 1.2) * 0.45; // sprout wags hard
      leafL.rotation.z += Math.sin(at * 13.0) * 0.28;
      leafR.rotation.z += Math.sin(at * 13.0 + 1.2) * 0.28;
      tail.rotation.y += Math.sin(at * 9.0) * 0.5;
      legFL.rotation.x += Math.sin(at * 12.0) * 0.35;
      legFR.rotation.x += Math.sin(at * 12.0 + Math.PI) * 0.35;
      legBL.rotation.x += Math.sin(at * 12.0 + 1.5) * 0.3;
      legBR.rotation.x += Math.sin(at * 12.0 + 4.6) * 0.3;
      shell.rotation.z += Math.sin(at * 6.0 - 0.9) * 0.08;
      break;
    }
  }

  // Ambient life layer: sprout/leaves/tail never sit perfectly still
  sprout.rotation.z += Math.sin(t * 2.4 + 1.3) * 0.04;
  leafL.rotation.z += Math.sin(t * 3.1) * 0.04;
  leafR.rotation.z += Math.sin(t * 3.1 + 2.1) * 0.04;
  tail.rotation.y += Math.sin(t * 1.8 + 0.7) * 0.05;
  shell.rotation.y += Math.sin(t * 0.9) * 0.015;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skills: SkillDef[] = [
  {
    id: 'sproutle.leaf-flick',
    nameKey: 'skill.sproutle.leaf-flick.name',
    descriptionKey: 'skill.sproutle.leaf-flick.desc',
    element: 'grass',
    targeting: 'projectile',
    cost: 6,
    cooldown: 1.8,
    power: 10,
    range: 14,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'sproutle.shell-spin',
    nameKey: 'skill.sproutle.shell-spin.name',
    descriptionKey: 'skill.sproutle.shell-spin.desc',
    element: 'grass',
    targeting: 'melee',
    cost: 12,
    cooldown: 5,
    power: 19,
    range: 2.8,
    learnAtLevel: 5,
    castAnim: 'special',
  },
  {
    id: 'sproutle.verdant-veil',
    nameKey: 'skill.sproutle.verdant-veil.name',
    descriptionKey: 'skill.sproutle.verdant-veil.desc',
    element: 'grass',
    targeting: 'support',
    cost: 16,
    cooldown: 10,
    power: 24,
    range: 6,
    storePrice: 190,
    castAnim: 'cast',
  },
  {
    id: 'sproutle.bramble-burst',
    nameKey: 'skill.sproutle.bramble-burst.name',
    descriptionKey: 'skill.sproutle.bramble-burst.desc',
    element: 'grass',
    targeting: 'aoe',
    cost: 21,
    cooldown: 9,
    power: 32,
    range: 6,
    storePrice: 340,
    castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export const species: BeastSpecies = {
  id: 'sproutle',
  nameKey: 'beast.sproutle.name',
  element: 'grass',
  locomotion: 'ground',
  descriptionKey: 'beast.sproutle.desc',
  baseStats: { maxHp: 58, attack: 9, defense: 14, speed: 3.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
