import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// ---------------------------------------------------------------------------
// Frostwing — a snowy owl of the high glaciers. Ice element, flying.
// Voxel scale 0.1: stands ~0.92 tall, wingspan ~2.2 when spread.
// ---------------------------------------------------------------------------

// Palette
//
// Chroma is deliberately much higher than the previous build. That owl was white
// plus four greys within 12% of each other, and since a portrait usually catches
// the front of the pal in shade, every one of those greys collapsed onto the same
// slate blue: a critic reading a real-game shot described the whole creature as
// "one narrow band of desaturated slate blue", which is exactly what it was. Snow
// still has to read as snow, so the white stays — the saturation went into the
// barring, the facial disc and a warm beak, which are the cells that survive shade.
// Both whites are now WARM-biased, which looks wrong in a swatch and right on the
// model. The sun is low here and a portrait usually catches the front of a pal in
// shade, where the only light is blue sky bounce — a neutral-to-cool white rendered
// under that reads as slate blue, and the owl came back from three separate capture
// rounds looking like a blue bird. Starting warm, the blue bounce lands on it and
// arrives at neutral snow. The ICE still reads: it lives in the barring, which is
// saturated cerulean and gets brighter, not bluer, in sun.
const WHITE = 0xfffaf1;   // snow plumage
const CREAM = 0xf7ecda;   // soft under-feathers
const SPECK = 0x63c3f2;   // ice-blue barring (was a near-grey 0x9fd2ec)
const SPECK2 = 0x2b93d8;  // deep cerulean: wingtips, tail bars, disc rim
const UNDER = 0xbdb7ae;   // shaded wing/belly underside — a NEUTRAL warm grey, one
                          // step down, so the wing's bottom plane separates from its
                          // top plane without turning the whole underside blue
const SHADOW = 0x968f88;  // deepest crease (under the jaw, wing roots)
const DISC = 0x86d2f7;    // heart facial-disc rim
const BEAK = 0xff8f2e;    // WARM orange beak. Slate-on-slate meant the beak simply
                          // did not exist in any shot; orange is also the only warm
                          // note on the bird, so it carries the whole face.
const BEAK_DK = 0xc25c12; // shaded underside of the beak / the hook
const IRIS = 0x1e2a3c;    // dark navy — a tint of the ice hue, never black
const EYE_LT = 0xfdfeff;  // catchlight
const BROW = 0xe8a63a;    // the surviving gold: a one-row brow over each eye. The
                          // old build stamped a 2x3 gold iris per side, which
                          // photographed as a welding mask.
const TALON = 0xcf9147;   // talons: muted amber, NOT the beak's full orange. Both
                          // feet sit within 0.09 of centre, so a saturated pair
                          // merged into one bright orange bar slung under the bird
                          // and out-read the beak it was supposed to echo.

const BODY_Y = 0.38;
// Head steps forward and up out of the shoulder line — the single landmark that
// turns a flying wedge back into a bird from 10 units away.
// 0.32, arrived at by measurement rather than taste: the head model's chin sits at
// HEAD_Y - 0.08 in body space and the wing slab's top face reaches +0.13, so
// anything under ~0.28 puts the wing roots across the facial disc — which is what
// made the owl photograph as a face with slabs through it.
const HEAD_X = 0, HEAD_Y = 0.32, HEAD_Z = 0.15;
/** Hover height PalActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;

type Parts = Record<string, THREE.Object3D>;

const s01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => { const x = s01(t); return x * x * (3 - 2 * x); };
const decay = (t: number, r: number): number => Math.exp(-r * Math.max(0, t));
/** Eased 0 -> 1 -> 0 bump inside [a, b]; riseFrac = fraction of window spent rising */
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
    id: 'frostwing.frost-dart',
    name: 'Frost Dart',
    description: 'Flicks a razor feather of ice that chills whatever it pricks.',
    element: 'ice', targeting: 'projectile',
    cost: 6, cooldown: 1.8, power: 11, range: 20,
    learnAtLevel: 1, castAnim: 'attack',
  },
  {
    id: 'frostwing.blizzard-wing',
    name: 'Blizzard Wing',
    description: 'One mighty wingbeat whips up a stinging ring of snow around the owl.',
    element: 'ice', targeting: 'aoe',
    cost: 14, cooldown: 6, power: 22, range: 6,
    learnAtLevel: 5, castAnim: 'cast',
  },
  {
    id: 'frostwing.aurora-veil',
    name: 'Aurora Veil',
    description: 'Weaves shimmering polar light overhead that gently mends allies beneath it.',
    element: 'ice', targeting: 'support',
    cost: 18, cooldown: 9, power: 20, range: 8,
    storePrice: 220, castAnim: 'cast',
  },
  {
    id: 'frostwing.comet-dive',
    name: 'Comet Dive',
    description: 'Folds its wings and falls like a frozen star. Impact included, free of charge.',
    element: 'ice', targeting: 'melee',
    cost: 22, cooldown: 11, power: 40, range: 4,
    storePrice: 360, castAnim: 'special',
  },
];

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * One hinged wing section. Cells run outward from the pivot along +/-X.
 *
 * Shape rules learned the hard way. The build this replaces made all three
 * sections identical rounded slabs of the same 5-6 cell chord, hinged in a chain
 * — which from any bearing photographed as a segmented tube curving away from the
 * shoulder. A critic looking at a real-game portrait called the pair a handlebar
 * moustache, and the read is unarguable once you see it: constant-chord segments
 * plus a hinge chain IS a jointed arm, not a wing.
 *
 * So now:
 *  - the chord TAPERS hard, 7 cells at the shoulder to 1 at the tip, so the plan
 *    form is a triangle. Taper is what makes a wing read as a wing;
 *  - the trailing edge is SCALLOPED (the aft-most z zigzags column to column),
 *    which is the feather cue, and it breaks the straight segment edges that made
 *    the sections legible as separate parts;
 *  - the leading two cells of each column are two rows thick and the rest is one,
 *    so the silhouette has a solid front spar without the whole plane reading as a
 *    slab. A uniformly 1-cell sheet is see-through edge-on; a uniformly 2-cell
 *    sheet is a plank.
 *
 * The chord table is written once and mirrored by the `sign` remap; authoring the
 * two sides separately is what let them drift apart in an earlier round.
 */
function wingSectionMesh(sign: number, kind: 'inner' | 'mid' | 'tip'): THREE.Mesh {
  const m = new VoxelModel();
  const X = (d: number): number => (sign > 0 ? d : -d - 1); // exact cell mirror
  const one = (d: number, y: number, z: number, c: number): void => {
    m.set(X(d), y, z, c);
  };
  /**
   * One chord column. `z1` is the leading edge (forward), `z0` the trailing edge.
   * The two forward-most cells get an underside so the leading edge is a solid
   * spar; everything aft of that is a single feather-thin row.
   */
  const vane = (d: number, z0: number, z1: number, top: number, edge: number): void => {
    for (let z = z0; z <= z1; z++) {
      one(d, 0, z, z === z0 ? edge : top);
      if (z >= z1 - 1) one(d, -1, z, UNDER);
    }
  };
  if (kind === 'inner') {
    // Shoulder coverts. Scalloped aft edge: -3 / -2 / -3 zigzag.
    const chord: Array<[number, number]> = [[-3, 3], [-2, 3], [-3, 2]];
    chord.forEach(([z0, z1], d) => vane(d, z0, z1, WHITE, SPECK));
    // Raised covert ridge along the leading edge — the wing's shoulder muscle.
    for (let d = 0; d <= 2; d++) one(d, 1, 3 - (d === 2 ? 1 : 0), CREAM);
    one(0, -1, 3, SHADOW); one(1, -1, 3, SHADOW); // deepest crease at the armpit
  } else if (kind === 'mid') {
    // Secondaries: chord 6 -> 5 -> 4, scalloped, sweeping aft as it goes out.
    const chord: Array<[number, number]> = [[-4, 1], [-3, 1], [-4, 0]];
    chord.forEach(([z0, z1], d) => vane(d, z0, z1, WHITE, d === 2 ? SPECK2 : SPECK));
    for (let d = 0; d <= 2; d++) one(d, 1, 1 - (d === 2 ? 1 : 0), CREAM);
  } else {
    // Primaries: three separated feather fingers of decreasing length, deep
    // cerulean at the tips. Gaps BETWEEN the fingers are the point — a solid
    // triangle here reads as a fin, three fingers read as a bird.
    const finger: Array<[number, number]> = [[-5, 0], [-5, -1], [-4, -2]];
    finger.forEach(([z0, z1], d) => vane(d, z0, z1, d === 0 ? WHITE : SPECK, SPECK2));
    one(0, 0, 0, CREAM); // lit knuckle where the primaries leave the wrist
  }
  // No emissive anywhere on the wing. An earlier build glowed along the SPECK edge,
  // which drew a neon cyan outline around the WRONG shape (the trailing edge) and
  // pulled the eye off the head. Ice reads as crisp and cold, not as neon.
  const mesh = m.build(0.1, false);
  mesh.position.y = -0.05;
  return mesh;
}

function buildRig(): PalRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  // --- torso: plump snowy chest with ice-blue speckles -------------------
  // Grown 2.6 -> 3.2 wide and 2.3 -> 2.7 deep so the barrel is at least as big as
  // the skull. A head wider than its own shoulders is what made the old rig read
  // as a face with wings bolted to it.
  const torso = new VoxelModel();
  torso.ellipsoid(0, 3, 0, 3.2, 2.8, 2.7, WHITE);
  // Breast marking. The previous one was a symmetric five-cell cross centred on the
  // chest, which photographed as a literal medical plus sign — a critic named it as
  // such. This is a deliberately ASYMMETRIC bib: a wedge of barring falling from the
  // bird's right shoulder across the crop, the way real owl streaking sits.
  torso.set(1, 4, 2, SPECK); torso.set(1, 3, 2, SPECK); torso.set(0, 3, 2, SPECK2);
  torso.set(2, 3, 1, SPECK); torso.set(0, 2, 2, CREAM); torso.set(-1, 2, 2, CREAM);
  torso.set(1, 2, 2, CREAM);
  // speckles across back and shoulders
  torso.set(0, 5, 1, SPECK); torso.set(1, 5, -1, SPECK); torso.set(-1, 5, 0, SPECK2);
  torso.set(2, 4, 0, SPECK); torso.set(-2, 4, -1, SPECK2);
  // Shaded belly: an all-white owl on a bright lawn has no bottom edge at all,
  // so the body floated free of its own legs in every ground shot.
  shadeUnder(torso, UNDER, -2, 2, 0, 2, -2, 2);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.28, 0);
  body.add(torsoMesh);

  // --- head: round skull + flat heart-shaped facial disc -----------------
  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  const head = new VoxelModel();
  head.ellipsoid(0, 2.2, -0.2, 3.1, 2.5, 2.4, WHITE);
  // The facial disc has to be a built plate — the skull's own curve is only three
  // cells wide at the face plane, too narrow to carry an eye pair. What was wrong
  // before was that the plate was a 7x4 RECTANGLE in the same white as the crown:
  // a square slab of one value photographs as a skull mask. Now it is a rounded
  // heart, one value warmer than the crown, with a pale-blue rim tracing its
  // outline — the shape that reads "owl" at a glance.
  const discRows: Array<[number, number]> = [
    // Row 4 widened to half-width 3: the eye's lid row lands there, and on a
    // 2-wide row the outer lid cell had nothing under it and stuck out of the disc.
    [5, 2], [4, 3], [3, 3], [2, 3], [1, 2], [0, 1], // [row y, half-width]
  ];
  for (const [y, hw] of discRows) {
    for (let x = -hw; x <= hw; x++) head.set(x, y, 2, CREAM);
    head.set(-hw, y, 2, DISC);
    head.set(hw, y, 2, DISC);
  }
  rimTop(head, CREAM, -3, 3, 0, 6, -2, 1);
  // Two steps of shade under the jaw, not one: the deeper SHADOW band is the
  // neck break that separates head from chest when the two are both snow-white.
  shadeUnder(head, UNDER, -3, 3, 0, 1, -2, 2);
  head.set(0, 0, 1, SHADOW); head.set(1, 0, 1, SHADOW); head.set(-1, 0, 1, SHADOW);
  // Dark navy eye on a cream disc — the strongest contrast available on a white
  // bird, and the gold survives as a single brow row per eye (`lid`) instead of the
  // 2x3 gold iris block that photographed as a welding mask.
  eyes2x2(head, {
    inner: 1, y: 2, faceZ: 2, iris: IRIS, shine: EYE_LT,
    lid: BROW, bridge: WHITE,
  });
  // Beak: a stepped WARM ORANGE wedge that tapers in profile — 2 cells proud at the
  // top row, 1 cell proud at the hook below, lit ridge on top and shaded underneath.
  // In slate grey this feature simply did not exist in any capture.
  head.set(0, 1, 3, BEAK);
  head.set(0, 1, 4, BEAK);
  head.set(0, 0, 3, BEAK_DK);  // downward hook, shaded
  head.set(0, 0, 4, BEAK_DK);
  // crown speckles
  head.set(1, 5, 0, SPECK); head.set(-1, 5, 0, SPECK2); head.set(0, 5, -1, SPECK);
  const headMesh = head.build(0.1, true);
  // +0.05z compensates the beak: build() centres on the bounding box, so growing
  // the model two cells forward would otherwise slide the skull back into the chest.
  headMesh.position.set(0, -0.08, 0.05);
  headGroup.add(headMesh);

  // --- wings: three hinged sections per side -----------------------------
  const mkWing = (sign: number): [THREE.Group, THREE.Group, THREE.Group] => {
    const rootG = new THREE.Group();
    // |x| = 0.20 against a torso half-width of 0.32 puts the root column a full cell
    // INSIDE the barrel, so no pose can open a gap between wing and body — the
    // failure mode a critic caught on the drakelet. y = +0.06 is shoulder height
    // rather than the old armpit-level -0.12, which is what let the wings hang below
    // the bird and read as drooping arms.
    rootG.position.set(sign * 0.20, 0.06, -0.06);
    rootG.add(wingSectionMesh(sign, 'inner'));
    const midG = new THREE.Group();
    midG.position.set(sign * 0.26, 0, -0.04); // each joint steps aft: swept plan form
    midG.add(wingSectionMesh(sign, 'mid'));
    rootG.add(midG);
    const tipG = new THREE.Group();
    tipG.position.set(sign * 0.26, 0, -0.04);
    tipG.add(wingSectionMesh(sign, 'tip'));
    midG.add(tipG);
    body.add(rootG);
    return [rootG, midG, tipG];
  };
  const [wingR, wingRMid, wingRTip] = mkWing(1);
  const [wingL, wingLMid, wingLTip] = mkWing(-1);

  // --- tail fan ----------------------------------------------------------
  const tailGroup = new THREE.Group();
  tailGroup.position.set(0, -0.14, -0.18);
  body.add(tailGroup);
  // A two-cell-thick fan that reaches a full 5 cells behind the wing roots. The
  // old tail was a single voxel sheet 3 cells long: edge-on it vanished, which is
  // half of why the rig read as a wing pair with no back end.
  const tail = new VoxelModel();
  const fan = [5, 4, 3]; // aft length by |x|, so the two halves cannot drift apart
  for (let x = -2; x <= 2; x++) {
    const len = fan[Math.abs(x)];
    for (let z = 0; z >= -len; z--) {
      tail.set(x, 0, z, WHITE);
      tail.set(x, -1, z, UNDER); // shaded underside, so the fan has a bottom
    }
  }
  // Ice-blue barring across the fan, following the feather direction (fore-aft)
  // rather than a chequer: two darker rachis lines and pale webbing between them.
  for (let z = 0; z >= -4; z--) { tail.set(1, 0, z, SPECK); tail.set(-1, 0, z, SPECK); }
  // Two cerulean cross-bars near the tip: barring across the fan is what makes it
  // read as a tail rather than as a white shelf, especially against pale sky.
  for (let x = -2; x <= 2; x++) { tail.set(x, 0, -3, SPECK2); }
  tail.set(0, 0, -5, SPECK2);
  const tailMesh = tail.build(0.1, true);
  tailMesh.position.set(0, -0.02, -0.28);
  tailGroup.add(tailMesh);

  // --- little talon feet -------------------------------------------------
  const mkLeg = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.09, -0.24, 0.03);
    const foot = new VoxelModel();
    foot.box(0, 0, 0, 0, 0, 1, TALON); // ONE cell wide, so the pair reads as two feet
    foot.set(0, 0, 2, TALON); // front claw, same muted amber: BEAK_DK here made the
                              // two feet read as a pair of bright red sticks
    const footMesh = foot.build(0.1, true);
    footMesh.position.set(0, -0.12, 0.02);
    g.add(footMesh);
    body.add(g);
    return g;
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  // Ground contact blob (see contactshadow.ts): the owl's true shadow falls a
  // metre and a half behind it under this low sun, so it needs an anchor.
  const blob = makeContactBlob(0.62, HOVER);
  root.add(blob);

  return {
    root,
    parts: {
      body, head: headGroup, tail: tailGroup,
      wingL, wingLMid, wingLTip, wingR, wingRMid, wingRTip,
      legL, legR, blob,
    },
    height: 0.92,
    radius: 0.45,
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

// Baked-in wing attitude, applied in every action so no branch can forget it.
// Euler order here is the default XYZ, i.e. Z (dihedral) is applied before Y
// (sweep) — raise the plane first, then swing it aft, which is the order that
// gives a swept-back wing rather than a twisted one.
//
// These two numbers are the whole fix for the "handlebar moustache" read: the old
// build left the base attitude at zero, so the wings sat level or below level and
// the hinge chain bent them into a downward arc off the shoulders.
const DIHEDRAL = 0.22;   // shoulder lift (rad) — the V that says "bird". 0.34 read
                         // as a shrug: with the beat's own +/-0.31 on top, the wings
                         // spent most of the cycle up beside the head and crowded it.
const SWEEP_AFT = 0.34;  // constant aft sweep (rad) at every joint — more of the
                         // span now goes backward than upward, which is the swept
                         // owl plan form rather than a raised pair of arms.

/** fold: 0 = spread, 1 = folded against body. up > 0 raises wings further. */
function poseWings(P: Parts, fold: number, up: number, midUp: number, tipUp: number): void {
  const sweep = SWEEP_AFT + 1.0 * fold;
  const droop = 0.24 * fold;
  const z0 = DIHEDRAL - droop + up;
  const z1 = DIHEDRAL * 0.55 + midUp;   // wrist continues the lift, a little less
  const z2 = DIHEDRAL * 0.35 + tipUp;   // primaries flatten out at the tip
  P.wingL.rotation.set(0, -sweep, -z0);
  P.wingR.rotation.set(0, sweep, z0);
  P.wingLMid.rotation.set(0, -0.55 * fold - SWEEP_AFT * 0.6, -z1);
  P.wingRMid.rotation.set(0, 0.55 * fold + SWEEP_AFT * 0.6, z1);
  P.wingLTip.rotation.set(0, -0.5 * fold - SWEEP_AFT * 0.5, -z2);
  P.wingRTip.rotation.set(0, 0.5 * fold + SWEEP_AFT * 0.5, z2);
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const P = rig.parts;
  const t = ctx.time, at = ctx.actionTime, ms = ctx.moveSpeed;

  // The blob has to stay flat on the ground whatever the rig is doing, and it
  // grows a little with the wingspan so the shadow matches the pose.
  updateContactBlob(P.blob, rig.root, 1 + 0.35 * Math.max(0, -P.wingL.rotation.z));

  // Absolute base pose every frame (branches then layer motion on top).
  P.body.position.set(0, BODY_Y, 0);
  P.body.rotation.set(0, 0, 0);
  P.body.scale.set(1, 1, 1);
  P.head.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  P.head.rotation.set(0, 0, 0);
  P.tail.rotation.set(0.15, 0, 0);
  P.legL.rotation.set(0, 0, 0);
  P.legR.rotation.set(0, 0, 0);

  switch (ctx.action) {
    case 'idle': {
      // Perched: soft breathing, folded wings, famously curious owl head.
      const br = Math.sin(t * 1.7);
      P.body.scale.set(1 - br * 0.008, 1 + br * 0.022, 1 - br * 0.008);
      P.body.position.y = BODY_Y + br * 0.006;
      const ruffle = Math.pow(Math.max(0, Math.sin(t * 0.21 + 1.3)), 24);
      poseWings(P, 1 - 0.25 * ruffle,
        0.025 * br + 0.16 * ruffle * Math.sin(t * 26),
        0.06 * ruffle * Math.sin(t * 26 - 0.5),
        0.09 * ruffle * Math.sin(t * 26 - 1.0));
      P.head.rotation.set(
        0.05 * Math.sin(t * 1.7 + 0.6),
        0.7 * Math.tanh(2.2 * Math.sin(t * 0.42)),   // dwell-and-swivel scan
        0.16 * Math.sin(t * 0.83 + 1.7));            // charming side tilt
      P.tail.rotation.set(0.15 + 0.03 * br, 0.08 * Math.sin(t * 0.9), 0);
      P.legL.rotation.x = 0.02 * br;
      P.legR.rotation.x = -0.02 * br;
      break;
    }

    case 'walk': {
      // Ground travel = a bouncy sparrow-hop waddle.
      const ph = t * 6.5;
      const hop = Math.max(0, Math.sin(ph));
      const land = 1 - hop;
      P.body.position.y = BODY_Y + hop * 0.06;
      P.body.scale.set(1 + 0.045 * land, 1 - 0.09 * land, 1 + 0.045 * land);
      P.body.rotation.set(0.08 * hop, 0, 0.05 * Math.sin(ph * 0.5));
      P.legL.rotation.x = 0.55 * Math.sin(ph);
      P.legR.rotation.x = 0.55 * Math.sin(ph + Math.PI);
      poseWings(P, 0.55, 0.12 * hop + 0.10 * Math.sin(ph + 0.5),
        0.08 * Math.sin(ph), 0.10 * Math.sin(ph - 0.4));
      P.head.rotation.set(0.10 - 0.12 * hop, 0.1 * Math.sin(t * 0.9), 0.05 * Math.sin(ph * 0.5));
      P.tail.rotation.set(0.2 + 0.15 * hop, 0.15 * Math.sin(ph), 0);
      break;
    }

    case 'run': {
      // Fast travel: skimming powered flight low over the ground.
      const ph = t * 8.5;
      const amp = 0.5 + 0.15 * ms;
      poseWings(P, 0,
        Math.sin(ph) * amp + 0.06,
        Math.sin(ph - 0.55) * amp * 0.8,
        Math.sin(ph - 1.1) * amp * 0.95);
      P.body.rotation.set(0.28, 0, 0.08 * Math.sin(t * 1.1));
      P.body.position.y = BODY_Y + Math.sin(ph - 0.95) * 0.05;
      P.head.rotation.set(-0.18, 0.06 * Math.sin(t * 1.3), -0.06 * Math.sin(t * 1.1));
      P.tail.rotation.set(-0.1 + 0.07 * Math.sin(ph - 1.3), 0, 0.05 * Math.sin(t * 1.1));
      P.legL.rotation.x = 1.15;
      P.legR.rotation.x = 1.15;
      break;
    }

    case 'fly':
    case 'swim': {
      // Slow, powerful flaps alternating with long glides; head stays level.
      const g = smooth((Math.sin(t * 0.33) + 1) * 0.7 - 0.2); // glide mix, dwells at ends
      const ph = t * (3.6 + 2.6 * ms);
      const amp = (0.16 + 0.44 * (0.35 + 0.65 * ms)) * (1 - 0.82 * g);
      // Positive base lift on all three sections = a shallow dihedral V. A bird
      // gliding with level or drooping wings reads as a paper glider; the V is the
      // silhouette that says "bird" at any distance, and it also keeps the wing
      // roots clear of the head through the whole beat.
      // The old per-branch +0.20/+0.14/+0.10 base lift is gone: DIHEDRAL in
      // poseWings now owns the resting attitude, so every action inherits the V.
      poseWings(P, 0,
        Math.sin(ph) * amp + 0.18 * g,
        Math.sin(ph - 0.55) * amp * 0.8 + 0.10 * g,
        Math.sin(ph - 1.1) * amp * 0.95 + 0.05 * Math.sin(t * 7.3) * g);
      // Barely any idle roll. A hovering owl rolled even 0.16 rad photographs as
      // one wing up and one wing down, which reads as a broken mirror rather than
      // as a bank — and the pal hovers in place for every portrait.
      const bank = Math.sin(t * 0.55) * (0.02 + 0.035 * g);
      const pitch = 0.16 + 0.12 * ms - 0.06 * Math.sin(ph - 0.9) * (1 - g);
      P.body.rotation.set(pitch, 0, bank);
      P.body.position.y = BODY_Y + Math.sin(ph - 0.95) * 0.05 * (1 - g) + Math.sin(t * 1.15) * 0.025 * g;
      P.head.rotation.set(-pitch * 0.55, Math.sin(t * 0.7) * 0.12, -bank * 0.7); // gyro-stable owl head
      P.tail.rotation.set(-0.12 + 0.07 * Math.sin(ph - 1.3) * (1 - g) + 0.05 * g, 0, bank * 0.5);
      P.legL.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.1);
      P.legR.rotation.x = 1.15 + 0.05 * Math.sin(t * 2.3);
      break;
    }

    case 'attack': {
      // Rear back with raised wings, then a snapping talon-and-beak strike.
      const wind = bump(at, 0.0, 0.30, 0.55);
      const strike = bump(at, 0.14, 0.55, 0.3);
      poseWings(P, 0.15,
        0.5 * wind - 0.5 * strike + 0.05 * Math.sin(t * 18),
        0.35 * wind - 0.3 * strike,
        0.3 * wind - 0.35 * strike);
      P.body.rotation.x = -0.15 * wind + 0.3 * strike;
      P.body.position.z = -0.05 * wind + 0.14 * strike;
      P.body.position.y = BODY_Y + 0.04 * wind - 0.03 * strike;
      P.head.rotation.x = -0.5 * wind + 0.85 * strike;
      P.head.position.z = HEAD_Z - 0.03 * wind + 0.10 * strike;
      P.head.position.y = HEAD_Y + 0.02 * wind - 0.04 * strike;
      P.tail.rotation.x = 0.15 + 0.3 * wind - 0.2 * strike;
      P.legL.rotation.x = 0.2 * wind - 0.7 * strike;
      P.legR.rotation.x = 0.2 * wind - 0.7 * strike;
      break;
    }

    case 'cast': {
      // Majestic rear-up: wings spread wide and high, tips shimmering.
      const rise = smooth(at / 0.5);
      const shimmer = Math.sin(t * 9) * 0.06 * rise;
      poseWings(P, 1 - rise,
        0.6 * rise + 0.1 * Math.sin(t * 2.6) * rise,
        0.35 * rise + shimmer,
        0.3 * rise + shimmer * 1.5);
      P.body.position.y = BODY_Y + 0.10 * rise + 0.02 * Math.sin(t * 3.1);
      P.body.rotation.x = -0.18 * rise;
      P.head.rotation.set(-0.28 * rise + 0.04 * Math.sin(t * 3.1), 0.06 * Math.sin(t * 1.9), 0);
      P.tail.rotation.set(0.5 * rise, 0.04 * Math.sin(t * 3.1), 0);
      P.legL.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.4);
      P.legR.rotation.x = -0.25 * rise + 0.05 * Math.sin(t * 2.6);
      break;
    }

    case 'special': {
      // Full flourish: wings sweep to a peak, slam down, then a shimmering hold.
      const gather = bump(at, 0, 0.5, 0.7);
      const slam = bump(at, 0.35, 0.8, 0.25);
      const after = smooth((at - 0.6) / 0.3);
      const shimmer = Math.sin(t * 16) * 0.12 * after * decay(at - 0.6, 1.2);
      poseWings(P, 0,
        1.05 * gather - 1.0 * slam + 0.4 * after + shimmer,
        0.6 * gather - 0.6 * slam + 0.25 * after + shimmer * 1.3,
        0.5 * gather - 0.7 * slam + 0.2 * after + shimmer * 1.6);
      P.body.position.y = BODY_Y - 0.06 * gather + 0.22 * slam + 0.08 * after;
      P.body.rotation.set(-0.2 * gather + 0.15 * slam, 0, 0.12 * Math.sin(at * 7) * slam);
      P.head.rotation.set(-0.35 * gather - 0.15 * after, 0, 0.1 * Math.sin(at * 7) * slam);
      P.tail.rotation.set(0.45 * gather + 0.3 * after, 0.08 * Math.sin(t * 5) * after, 0);
      P.legL.rotation.x = 0.3 * gather - 0.4 * slam;
      P.legR.rotation.x = 0.3 * gather - 0.4 * slam;
      break;
    }

    case 'hurt': {
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

    case 'happy': {
      // Delighted bouncing, fluttery half-open wings, big head tilts.
      const ph = at * 9;
      const b = Math.abs(Math.sin(ph));
      const land = 1 - b;
      P.body.position.y = BODY_Y + 0.08 * b;
      P.body.scale.set(1 + 0.05 * land, 1 - 0.09 * land, 1 + 0.05 * land);
      P.body.rotation.set(-0.05 * b, 0.2 * Math.sin(at * 3.1), 0.05 * Math.sin(ph));
      poseWings(P, 0.3,
        0.25 * b + 0.28 * Math.abs(Math.sin(at * 14)),
        0.2 * Math.sin(at * 14 - 0.4),
        0.25 * Math.sin(at * 14 - 0.8));
      P.head.rotation.set(-0.1 * b, 0.3 * Math.sin(at * 2.2), 0.35 * Math.sin(at * 4.5));
      P.tail.rotation.set(0.3 + 0.2 * b, 0.35 * Math.sin(at * 8), 0);
      P.legL.rotation.x = 0.3 * Math.sin(at * 12);
      P.legR.rotation.x = 0.3 * Math.sin(at * 12 + Math.PI);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
export const species: PalSpecies = {
  id: 'frostwing',
  name: 'Frostwing',
  element: 'ice',
  locomotion: 'flying',
  description:
    'A snowy owl born in the heart of a glacier. It drifts on silent wings, '
    + 'watching everything with polite, unblinking curiosity, and its speckles '
    + 'glitter like fresh frost at dawn.',
  baseStats: { maxHp: 44, attack: 13, defense: 7, speed: 6.5 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
