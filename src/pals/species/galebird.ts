import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';
import { makeContactBlob, updateContactBlob } from './contactshadow';

// ---------------------------------------------------------------------------
// Galebird — a swift teal swallow, the fastest set of wings in the valley.
// Long forked tail streamers trail through its turns; wings tuck in dives.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette — every teal was lifted a full value step in round 6. Flying against
// dark tree canopy with its shaded side to camera, the old 0x2fa9a4 / 0x1c7480 /
// 0x145a66 set photographed as one black smudge: the mid-tone was only ~40%
// luminance and the fill light is 0.52 against a 2.55 sun.
const TEAL = 0x54dbcd;      // main coat
const RIM = 0xb2f6e9;       // sunlit crest along back, crown and leading edges
const DEEP = 0x2f9cae;      // back cap
const DUSKTEAL = 0x27889a;  // wingtips / trailing edge
const UNDER = 0x5b93a4;     // shaded wing underside — mid, never a void
const MIST = 0xcdeee8;      // gradient step toward the belly
const WHITE = 0xf6fdfb;     // belly
const RUST = 0xf2814f;      // throat patch accent
const BEAK = 0xffc24d;      // warm amber beak: a near-black beak on a bird this
                            // small simply disappeared into the head
const BEAK_DK = 0xc07f21;   // lower mandible / shaded beak side, so the beak has
                            // two values and stops reading as a flat gold ingot
const FOOT = 0x4d5361;
const TOE = 0x8f96a3;       // lit toe cells — the feet were one dark blob
// Dark iris, light face — the inversion the whole roster now shares. The old pale
// gold 2x3 iris on a tan face plate merged into it, leaving only the pupils, and a
// critic reading the portrait called them "wide black eye slots".
const IRIS = 0x0f2b33;      // dark teal iris
const SHINE = 0xf2ffff;     // single catchlight cell
const COLLAR = 0xd9f4ee;    // pale nape band: the head/body break
const STREAM_TIP = 0xd8ecf2; // pale tail-streamer tips: the dark tips vanished
                             // against the ground, cutting the fork off the bird

// Base pose constants (world/local units, must match buildRig)
const BODY_Y = 0.3;
// Head sits low and close: with the old 0.1 / 0.3 the big new skull eclipsed the
// whole fuselage in a head-on portrait and the bird read as a floating face.
// The skull steps UP and FORWARD out of the shoulder line (0.02/0.26 -> 0.07/0.30).
// Flush with the fuselage there was no head/body break at all and the bird read as
// one continuous teal lozenge with a bill stuck on the front.
const HEAD_Y = 0.07;
const HEAD_Z = 0.30;
const STREAM_X = -0.55;  // resting streamer droop
const STREAM_YAW = 0.14; // fork spread
/** Hover height PalActor holds a flyer at; the contact blob has to match it. */
const HOVER = 1.55;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  // Fuselage widened 2.2 -> 2.6 at the same time as the skull came down from 3.0.
  // Those two numbers being the wrong way round is the whole of the "80% head, no
  // body" read: a 7-cell skull in front of a 5-cell body hides the body completely.
  m.ellipsoid(0, 1.8, -0.2, 2.6, 1.9, 3.8, TEAL);   // sleek fuselage
  m.ellipsoid(0, 2.7, -0.8, 1.8, 1.2, 3.0, DEEP);   // dark back cap
  m.ellipsoid(0, 0.9, 0.5, 1.9, 1.3, 3.2, MIST);    // gradient step
  m.ellipsoid(0, 0.4, 0.7, 1.6, 0.9, 2.7, WHITE);   // white belly
  m.ellipsoid(0, 1.9, -3.3, 1.2, 1.1, 1.4, DEEP);   // tapered rump
  // Sunlit crest along the whole spine: one bright cell per column. Without it
  // the fuselage is a single flat value from any angle that isn't top-down.
  rimTop(m, RIM, -2, 2, 0, 5, -5, 4);
  // Shaded keel along the belly's turn-under: the pale belly alone made the
  // fuselage read as a flat white oval from below.
  shadeUnder(m, UNDER, -2, 2, 0, 4, -5, 4);
  // ONE compact foot block tucked under the belly, but with three lit toe cells
  // pointing forward so it reads as feet rather than as a dark rectangle. Two
  // fully separate legs at this cell count broke the dart silhouette; at 10 cm
  // per cell a dart with toes beats anatomy.
  // TWO legs, not one block. A single tucked rectangle was legible as "some dark
  // thing under the belly" and a critic counted the bird as having no legs or feet at
  // all; two separated columns with their own toes give the silhouette its third
  // mass (head / body / limbs) even at portrait distance. Each leg's top cell is
  // inside the belly ellipsoid, so no pose can open a gap at the hip.
  for (const sx of [1, -1]) {
    m.box(sx, -2, -1, sx, 0, 1, FOOT);
    m.set(sx, -2, 2, TOE);        // forward toe
    m.set(sx * 2, -2, 1, TOE);    // outboard toe: splays the foot so it reads wide
    m.set(sx, -2, -2, FOOT);      // hind toe
  }
  // Pale nape band where the skull meets the shoulders. Head and fuselage were
  // the same teal at the same value, which is why the bird photographed as one
  // continuous mass with a beak stuck on the front.
  // On the THROAT (front of the chest, under the chin) only. A first attempt also
  // ran a band across the top of the shoulders at y=3, which from a head-on bearing
  // appeared above the skull as a pale plate floating on the bird's head.
  // (x = -1..1 is the widest the fuselage actually reaches at that row.)
  for (let x = -1; x <= 1; x++) m.set(x, 2, 3, COLLAR);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // Volume cut ~40% from the previous 3.0 x 2.1 x 1.8. That skull was SEVEN cells
  // across on a five-cell fuselage; at bearing 275 the portrait was a teal cube
  // filling a third of the frame with a strip of body behind it. Five cells across
  // and one row shallower is still a chunky swallow head — it is just no longer
  // bigger than the bird.
  m.ellipsoid(0, 1.9, 0.1, 2.3, 1.8, 1.7, TEAL);
  m.ellipsoid(0, 3.0, -0.3, 2.0, 0.9, 1.4, DEEP);   // dark crown cap
  m.ellipsoid(0, 0.9, 1.2, 1.3, 0.8, 1.0, RUST);    // rust throat bib, kept small
  // and high — as a full lower-face mass it read as a dark red wound under the beak
  m.box(-2, 1, 2, 2, 4, 2, TEAL);                    // flat face plate the eyes
  // hang on: on the bare ellipsoid the outer eye column floated free of the skull
  rimTop(m, RIM, -2, 2, 0, 5, -2, 2);
  // Shadow line under the jaw and cheeks: without it the head and the chest are
  // the same value and the bird photographs as one continuous lozenge.
  shadeUnder(m, DUSKTEAL, -2, 2, 0, 1, -2, 0);
  // inner: 1 brackets a single-cell nose bridge, which is all a five-cell face has
  // room for and is where a swallow's eyes actually sit. The bridge cell is stamped
  // one cell PROUD by the macro, and that lit ridge is what stops the pair merging
  // into one wide slot across the face.
  // Pale mask across the eye rows before the eyes go in. On a teal face plate in shade
  // a dark teal iris has no boundary at all; MIST gives each eye a light field to sit
  // against, and it doubles as the swallow's pale cheek.
  for (let x = -2; x <= 2; x++) { m.set(x, 2, 2, MIST); m.set(x, 3, 2, MIST); }
  eyes2x2(m, {
    inner: 1, width: 1, y: 2, faceZ: 2, iris: IRIS, shine: SHINE,
    lid: DUSKTEAL, browProud: true, bridge: RIM,
  });
  return m.build(S, true);
}

function makeBeak(): THREE.Mesh {
  const m = new VoxelModel();
  // A SMALL amber dagger: 3 cells wide and 2 tall at the base, dropping to a single
  // centred cell two steps out. The previous beak was 3 x 2 x 3 solid — 0.3 x 0.2
  // units on a 0.7-wide head, so it covered nearly half the face and photographed as
  // a gold ingot glued on. A swallow's bill is barely there.
  // ONE cell wide now, down from three. Cutting the skull from seven cells to five
  // left the old 3-wide bill covering more than half the face, and a front-on portrait
  // came back as a gold ingot with a bird behind it — the exact failure the previous
  // round had already fixed once at the old head size.
  m.set(0, 1, 0, BEAK);                 // upper mandible
  m.set(0, 0, 0, BEAK_DK);              // lower mandible in shadow: two values
  m.set(0, 1, 1, BEAK);
  m.set(0, 1, 2, BEAK);                 // point
  return m.build(S, true);
}

/**
 * Inner wing section. dir=1 builds toward +x (left), dir=-1 mirrors.
 * Two voxel layers thick over the full chord: a one-cell plank is literally
 * invisible edge-on, which is why every side-on flyer portrait lost its wings.
 * Straight trailing edge on purpose — the taper lives in the outer section, so
 * inner + outer read as one clean swept dart.
 */
function makeWingInner(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  for (let x = 0; x <= 2; x++) {
    m.box(X(x), 0, -3, X(x), 0, 2, TEAL); // top surface, chord widened to 6
    m.set(X(x), 0, 2, RIM);               // bright leading edge catches the sun
    m.set(X(x), 0, -3, DUSKTEAL);         // dark trailing edge defines the chord
    // Full shaded underside: the wing has real thickness and a dark belly, so
    // it reads as a wing whether you see the top, the bottom or just the edge.
    m.box(X(x), -1, -3, X(x), -1, 1, UNDER);
  }
  return m.build(S, false);
}

/** Outer wing section: a six-column scythe with both edges raked aft. */
function makeWingOuter(dir: 1 | -1): THREE.Mesh {
  const X = (x: number): number => (dir === 1 ? x : -1 - x);
  const m = new VoxelModel();
  // Six columns, not four. A swallow's defining shape is a wing far longer than
  // its own body, and at four columns the tip reached only 0.85 units from
  // centreline — 84% of the frostwing's, on a bird with two thirds the frostwing's
  // fuselage. In the four-flyer lab lineup the galebird read as a teal fish with
  // fins while every other flyer read as winged. Six columns put the tip at 1.05,
  // i.e. the longest wing in the roster relative to its owner, which is the point.
  //
  // Both edges now rake aft (leading 1 -> -4, trailing -3 -> -5) instead of a
  // straight trailing edge at -3. A straight trailing edge on a long wing is a
  // rectangle with a bevel; raking both gives the scimitar plan form, and the
  // chord still tapers 5 -> 2 so the tip comes to a point.
  const front = [1, 0, -1, -2, -3, -4];
  const back = [-3, -3, -4, -4, -5, -5];
  for (let x = 0; x < 6; x++) {
    // Last two columns are the dark primaries: a swallow's wingtip is nearly
    // black against sky, and it is what stops the taper fading into the backdrop.
    const tip = x >= 4;
    m.box(X(x), 0, back[x], X(x), 0, front[x], tip ? DUSKTEAL : TEAL);
    m.set(X(x), 0, front[x], tip ? DUSKTEAL : RIM); // leading edge
    m.set(X(x), 0, back[x], DUSKTEAL);              // trailing edge
    if (x < 4) m.box(X(x), -1, back[x], X(x), -1, front[x] - 1, UNDER);
  }
  return m.build(S, false);
}

function makeTailFan(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(-2, 0, -3, 2, 0, 0, TEAL);   // wider swallow fan: the old 3x3 nub read
  m.box(-2, 0, -3, 2, 0, -3, DEEP);  // as a lump rather than a steering surface
  m.box(-1, -1, -2, 1, -1, 0, UNDER); // shaded underside for edge-on thickness
  m.set(-2, 0, 0, MIST);
  m.set(2, 0, 0, MIST);
  return m.build(S, true);
}

function makeStreamer(): THREE.Mesh {
  const m = new VoxelModel();
  const colors = [DEEP, DEEP, TEAL, TEAL, STREAM_TIP, STREAM_TIP, STREAM_TIP];
  for (let i = 0; i < colors.length; i++) {
    m.set(0, 0, -i, colors[i]);
    // Second cell of width for the first half of the streamer: a 1x1 ribbon was
    // a single hairline pixel at gameplay distance and the fork vanished.
    if (i < 4) m.set(1, 0, -i, colors[i]);
  }
  return m.build(S, false);
}

function buildRig(): PalRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  // -0.1, not -0.2: build() anchors y=0 at the lowest voxel and the merged foot
  // block reaches one cell less far down than the old dangling legs did, so this
  // keeps the fuselage at exactly the same altitude.
  torso.position.set(0, -0.1, 0);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  // -0.22, not -0.14: the taller skull adds a row below the old eye line, so the
  // pivot has to drop with it or the head floats off the shoulders.
  headMesh.position.set(0, -0.22, 0.02);
  head.add(headMesh);

  const beak = makeBeak();
  // -0.16 puts the upper mandible level with the bottom eye row instead of straight
  // across the middle of both eyes, where beak and irises merged into one gold bar.
  beak.position.set(0, -0.16, 0.25);
  head.add(beak);

  // Wings: two hinged sections per side, pivots at the shoulder and elbow.
  const mkWing = (dir: 1 | -1): [THREE.Group, THREE.Group] => {
    const shoulder = new THREE.Group();
    shoulder.position.set(dir * 0.17, 0.06, 0.04);
    body.add(shoulder);
    const inner = makeWingInner(dir);
    inner.position.set(0, -0.05, 0);
    shoulder.add(inner);
    const elbow = new THREE.Group();
    elbow.position.set(dir * 0.28, 0, -0.02);
    shoulder.add(elbow);
    const outer = makeWingOuter(dir);
    outer.position.set(0, -0.05, 0);
    elbow.add(outer);
    return [shoulder, elbow];
  };
  const [wingL, wingLOut] = mkWing(1);
  const [wingR, wingROut] = mkWing(-1);

  const tail = new THREE.Group();
  tail.position.set(0, 0.02, -0.36);
  body.add(tail);
  const fan = makeTailFan();
  fan.position.set(0, -0.05, 0.02);
  tail.add(fan);

  // Forked tail streamers — long, thin, trailing.
  const mkStreamer = (dir: 1 | -1): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(dir * 0.06, 0, -0.14);
    g.rotation.set(STREAM_X, dir * STREAM_YAW, 0);
    tail.add(g);
    const mesh = makeStreamer();
    mesh.position.set(-0.05, -0.05, 0.06);
    g.add(mesh);
    return g;
  };
  const streamerL = mkStreamer(1);
  const streamerR = mkStreamer(-1);

  // Ground contact blob — see contactshadow.ts. Without it a hovering swallow
  // sits in front of the scenery instead of over it.
  const blob = makeContactBlob(0.5, HOVER);
  root.add(blob);

  return {
    root,
    parts: {
      body, head, beak, wingL, wingLOut, wingR, wingROut, tail, streamerL, streamerR, blob,
    },
    height: 0.55,
    radius: 0.35,
  };
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.2);

  // Ground blob: flat on the terrain whatever the bird is doing, and a touch
  // wider when the wings are spread.
  updateContactBlob(p.blob, rig.root, 1 + 0.3 * clamp01(p.wingL.rotation.z));

  // Pose state — everything is written every frame.
  let bpx = 0, bpy = BODY_Y, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.01 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0;
  let beakX = 0;
  let flapL = 0.12, flapR = 0.12, outL = 0.1, outR = 0.1;
  let sweepL = 0.15, sweepR = 0.15;
  let tfx = 0.1, tfy = 0;
  let slx = STREAM_X, sly = 0, srx = STREAM_X, sry = 0;

  switch (ctx.action) {
    case 'idle': {
      // Hovering flutter: quick shallow beats, curious looks, streamers swaying.
      // Amplitude pulled down from 0.5 to 0.3 and centred on level: the old
      // beat swung both wings up past vertical, so a head-on hover portrait
      // caught them edge-on behind the skull instead of spread wide.
      const ph = t * 4.4;
      // Same wrist rule as the flight beat: the outer section trails the inner
      // at 0.6x and 0.45 rad rather than matching it a near-half-cycle behind,
      // which is what creased the wing shut at mid-stroke. Centre lifted to 0.09
      // so the resting hover holds a shallow V.
      flapL = flapR = 0.09 + 0.3 * Math.sin(ph);
      outL = outR = 0.18 * Math.sin(ph - 0.45);
      sweepL = sweepR = 0.12 + 0.05 * Math.sin(ph - 0.4);
      bpy += 0.035 * Math.sin(ph - 1.3) + 0.02 * Math.sin(t * 1.3);
      bsy = 1 + 0.02 * br;
      bsx = bsz = 1 - 0.008 * br;
      brx = 0.03 + 0.02 * Math.sin(t * 1.1); // near-level hover
      hrx = -0.08 + 0.05 * Math.sin(t * 1.2 + 0.5);
      hry = 0.3 * Math.sin(t * 0.33);
      hrz = 0.04 * Math.sin(t * 0.5) + 0.28 * Math.max(0, Math.sin(t * 0.41 + 1.7)) ** 12; // curious tilt
      beakX = 0.3 * Math.max(0, Math.sin(t * 0.27 + 3)) ** 24; // occasional chirp
      tfx = 0.15 + 0.06 * Math.sin(t * 1.7);
      tfy = 0.08 * Math.sin(t * 0.9);
      const sw = t * 1.5;
      slx = STREAM_X + 0.08 * Math.sin(sw);
      srx = STREAM_X + 0.08 * Math.sin(sw + 0.7);
      sly = 0.16 * Math.sin(sw - 0.9);
      sry = 0.16 * Math.sin(sw - 1.6);
      break;
    }
    case 'swim': {
      // Ditched-swallow paddle: rides low with the wings half-furled, sculling
      // in short alternating strokes and holding the head high and dry. Shares
      // nothing with the flight beat, which is the whole point of a separate case.
      const ph = t * 3.4;
      flapL = 0.1 + 0.34 * Math.sin(ph);
      flapR = 0.1 + 0.34 * Math.sin(ph + Math.PI);
      outL = 0.5 + 0.22 * Math.sin(ph - 0.7);
      outR = 0.5 + 0.22 * Math.sin(ph + Math.PI - 0.7);
      sweepL = sweepR = 0.85;              // wings furled against the flanks
      bpy += 0.02 * Math.sin(t * 2.1) - 0.03;
      brx = -0.12;                         // tail-down, breast-up trim
      brz = 0.06 * Math.sin(ph);
      hrx = 0.1 + 0.05 * Math.sin(t * 1.4);
      hry = 0.22 * Math.sin(t * 0.5);
      beakX = 0.25 * Math.max(0, Math.sin(t * 0.9)) ** 12;
      tfx = -0.15;                          // fan trails flat on the surface
      tfy = 0.1 * Math.sin(ph - 0.9);
      slx = srx = STREAM_X - 0.55;          // streamers float out behind
      sly = 0.3 * Math.sin(t * 1.6);
      sry = 0.3 * Math.sin(t * 1.6 + 1.1);
      break;
    }
    case 'walk':
    case 'run':
    case 'fly': {
      // Darting flight: flap bursts, brief glides, hard banks; wings tuck in dives.
      const f = 7.5 + 5 * ms;
      const ph = t * f;
      const glide = Math.max(0, Math.sin(t * 0.47 + 2.0)) ** 6;
      const dive = smooth(clamp01((ms - 0.65) / 0.35)) * Math.max(0, Math.sin(t * 0.31 + 0.8)) ** 4;
      const g = glide * (1 - dive);
      const amp = (0.55 + 0.45 * ms) * (1 - 0.85 * g) * (1 - 0.9 * dive);
      const bank = 0.42 * Math.sin(t * 0.77) * ms * (1 - dive);
      // Wrist FOLLOWS the shoulder, it does not fight it. The previous outer
      // section ran at 1.3x the inner amplitude a full 0.75 rad behind, so both
      // joints hit their extremes together and the wing spent the whole beat
      // creased into a deep V — measured off a four-flyer lab lineup at
      // t = 1.50/1.62/1.74, the galebird's wing presented as a pair of backswept
      // FINS in every frame while the frostwing beside it (outer 0.8x, lag 0.55)
      // held a readable plane. 0.62x at 0.42 rad keeps the wing near-planar
      // through the stroke and leaves just enough lag to read as feather whip.
      // Beat centre lifted 0.10 -> 0.17: a swallow hovers on a shallow dihedral V,
      // and at 0.10 the mean pose was flat, which is the paper-glider silhouette.
      flapL = amp * Math.sin(ph) + 0.17 + 0.15 * g - 0.55 * dive + 0.1 * bank;
      flapR = amp * Math.sin(ph + 0.07) + 0.17 + 0.15 * g - 0.55 * dive - 0.1 * bank;
      outL = amp * 0.62 * Math.sin(ph - 0.42) + 0.05 - 0.35 * dive;
      outR = amp * 0.62 * Math.sin(ph - 0.35) + 0.05 - 0.35 * dive;
      sweepL = sweepR = 0.18 + 0.25 * ms + 0.85 * dive - 0.12 * g; // tuck hard in dives
      brz = bank;
      bry = 0.16 * Math.sin(t * 0.77 - 0.5) * ms;
      brx = -0.04 + 0.16 * ms + 0.35 * dive - 0.08 * g;
      bpy += 0.035 * Math.sin(ph - 1.1) * (1 - g) * (1 - dive) + 0.025 * Math.sin(t * 1.9) - 0.06 * dive;
      bpz = 0.05 * dive;
      bsz = 1 + 0.05 * dive;
      bsx = 1 - 0.03 * dive;
      hrx = -brx * 0.75; // gaze stabilization against pitch
      hry = -bry * 0.6;
      hrz = -bank * 0.55;
      tfx = 0.08 + 0.1 * ms - 0.15 * dive;
      tfy = -0.3 * bank; // fan steers into the turn
      slx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1);
      srx = STREAM_X + 0.45 * ms + 0.05 * Math.sin(t * 3.1 + 0.6);
      sly = -1.1 * bank + 0.18 * Math.sin(t * 2.7); // streamers trail wide in turns
      sry = -1.1 * bank + 0.18 * Math.sin(t * 2.7 + 0.8);
      break;
    }
    case 'attack': {
      // Slashing dive-strike: rear up wings-high, then shear forward, tucked.
      const wind = smooth(phase(at, 0, 0.14));
      const lunge = ezOut(phase(at, 0.14, 0.3));
      const rec = smooth(phase(at, 0.5, 0.85));
      const k = -wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      brx = -0.45 * wind * (1 - lunge) + 0.5 * kp;
      bpz = 0.28 * k;
      bpy += 0.1 * wind * (1 - lunge) - 0.05 * kp;
      bsz = 1 + 0.12 * kp;
      bsx = 1 - 0.05 * kp;
      flapL = flapR = 1.1 * wind * (1 - lunge) - 0.5 * kp + 0.15 * Math.sin(t * 30) * kp;
      outL = outR = 0.5 * wind * (1 - lunge) - 0.35 * kp;
      sweepL = sweepR = 0.15 + 0.9 * kp;
      hrx = -brx * 0.6; // beak stays locked on the target
      beakX = 0.5 * kp;
      tfx = 0.3 * wind * (1 - lunge) - 0.2 * kp;
      slx = srx = STREAM_X + 0.2 * wind + 0.75 * kp;
      sly = 0.3 * Math.sin(at * 28) * kp;
      sry = -sly;
      break;
    }
    case 'cast': {
      // Rear-up flourish: wings fanned wide, tips trembling with gathered wind.
      const rise = ezOut(clamp01(at / 0.4));
      const trem = 0.5 * Math.sin(t * 14) + 0.5 * Math.sin(t * 21);
      brx = -0.55 * rise + 0.02 * trem * rise;
      bpy += 0.12 * rise;
      flapL = flapR = 0.95 * rise + 0.1 * Math.sin(t * 23) * rise;
      outL = outR = 0.35 * rise + 0.18 * Math.sin(t * 23 + 1.2) * rise;
      sweepL = sweepR = 0.15 - 0.25 * rise;
      hrx = 0.35 * rise; // gaze stays down-range
      beakX = 0.35 * rise;
      tfx = 0.3 * rise;
      slx = srx = STREAM_X - 0.3 * rise;
      sly = 0.35 * rise + 0.05 * Math.sin(t * 9);
      sry = -0.35 * rise - 0.05 * Math.sin(t * 9 + 1);
      break;
    }
    case 'special': {
      // Barrel-roll gale: full roll, then a huge braking wing-flare.
      const T = 0.85;
      const k = clamp01(at / T);
      const arc = Math.sin(Math.PI * k);
      const flare = Math.sin(Math.PI * phase(at, T, T + 0.3)) * (1 - smooth(phase(at, T + 0.3, T + 0.7)));
      // Weight settles after the brake: a damped sink with the wings drooping
      // half a beat behind the body, so the roll ends on a breath instead of
      // snapping straight back to the hover pose.
      const settle = Math.exp(-4.5 * Math.max(0, at - (T + 0.3))) * smooth(phase(at, T + 0.25, T + 0.45));
      brz = Math.PI * 2 * smooth(k);
      brx = -0.2 * arc - 0.3 * flare + 0.14 * settle;
      bpy += 0.3 * arc + 0.08 * flare - 0.07 * settle;
      bsy = 1 - 0.09 * settle;
      bsx = bsz = 1 + 0.05 * settle;
      flapL = flapR = 0.35 - 0.2 * arc + 1.0 * flare - 0.4 * settle;
      outL = outR = 0.2 + 0.5 * flare - 0.5 * settle;
      sweepL = sweepR = 0.15 + 0.6 * arc * (1 - flare) + 0.3 * settle;
      hrz = -0.2 * flare;
      hrx = -0.15 * flare + 0.2 * settle;
      beakX = 0.4 * flare;
      tfy = 0.3 * Math.sin(at * 16 + 1);
      slx = srx = STREAM_X + 0.5 * arc;
      sly = 0.9 * Math.sin(at * 16); // streamers corkscrew through the roll
      sry = 0.9 * Math.sin(at * 16 + 2.1);
      break;
    }
    case 'hurt': {
      // Feathers-everywhere flinch: knocked back, wings flailing out of sync.
      const d = Math.exp(-3.5 * at);
      bpx = 0.05 * Math.sin(at * 40) * d;
      bpy += -0.07 * d + 0.02 * Math.sin(at * 35) * d;
      bpz = -0.12 * d;
      brz = 0.25 * Math.sin(at * 26) * d;
      brx = -0.2 * d;
      flapL = (0.3 + 0.8 * Math.sin(at * 34)) * d + 0.12 * (1 - d);
      flapR = (0.3 + 0.8 * Math.sin(at * 34 + Math.PI)) * d + 0.12 * (1 - d);
      outL = 0.5 * Math.sin(at * 34 + 1) * d;
      outR = 0.5 * Math.sin(at * 34 + Math.PI + 1) * d;
      hrx = -0.3 * d;
      hrz = 0.15 * Math.sin(at * 30) * d;
      beakX = 0.6 * d;
      slx = srx = STREAM_X - 0.3 * d;
      sly = 0.2 * Math.sin(at * 30) * d;
      sry = -sly;
      break;
    }
    case 'happy': {
      // Giddy bounce-hover with chirps and streamer swishes.
      const hf = 5.4;
      const hop = Math.abs(Math.sin(at * hf));
      const ph = t * 13;
      bpy += 0.15 * hop;
      bry = 0.3 * Math.sin(at * 2.4);
      brz = 0.08 * Math.sin(at * hf * 2);
      flapL = 0.3 + 0.55 * Math.sin(ph);
      flapR = 0.3 + 0.55 * Math.sin(ph + 0.3);
      outL = 0.5 * Math.sin(ph - 0.7);
      outR = 0.5 * Math.sin(ph - 0.4);
      sweepL = sweepR = 0.1;
      hrx = -0.12;
      hrz = 0.25 * Math.sin(at * 2.4 + 1);
      beakX = 0.4 * Math.max(0, Math.sin(at * hf)) ** 2; // chirping with each hop
      tfx = 0.25;
      tfy = 0.25 * Math.sin(at * 6);
      const wag = at * 12;
      slx = srx = STREAM_X + 0.2;
      sly = 0.5 * Math.sin(wag);
      sry = 0.5 * Math.sin(wag - 0.7);
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, HEAD_Y, HEAD_Z);
  p.head.rotation.set(hrx, hry, hrz);
  p.beak.rotation.set(beakX, 0, 0);
  p.wingL.rotation.set(0, sweepL, flapL);
  p.wingR.rotation.set(0, -sweepR, -flapR);
  p.wingLOut.rotation.set(0, 0.25 * sweepL, outL);
  p.wingROut.rotation.set(0, -0.25 * sweepR, -outR);
  p.tail.rotation.set(tfx, tfy, 0);
  p.streamerL.rotation.set(slx, STREAM_YAW + sly, 0.02 * Math.sin(t * 8.3));
  p.streamerR.rotation.set(srx, -STREAM_YAW + sry, 0.02 * Math.sin(t * 8.3 + 1.4));
}

export const skills: SkillDef[] = [
  {
    id: 'galebird.gust-dart',
    name: 'Gust Dart',
    description: 'Snaps its wings shut and flings a whistling blade of compressed air.',
    element: 'wind',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.6,
    power: 10,
    range: 16,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'galebird.skyshear-dive',
    name: 'Skyshear Dive',
    description: 'Folds into a teardrop and shears past the target, wingtips slicing like scissors.',
    element: 'wind',
    targeting: 'melee',
    cost: 11,
    cooldown: 3.6,
    power: 20,
    range: 3,
    learnAtLevel: 5,
    castAnim: 'attack',
  },
  {
    id: 'galebird.tailwind',
    name: 'Tailwind',
    description: 'Carves a lazy circle overhead, kicking up a tailwind that hurries the whole team along.',
    element: 'wind',
    targeting: 'support',
    cost: 12,
    cooldown: 9,
    power: 10,
    range: 7,
    storePrice: 150,
    castAnim: 'cast',
  },
  {
    id: 'galebird.cyclone-waltz',
    name: 'Cyclone Waltz',
    description: 'Spins a pirouette so fast the sky joins in, wrapping everything nearby in a shrieking tornado.',
    element: 'wind',
    targeting: 'aoe',
    cost: 23,
    cooldown: 11,
    power: 42,
    range: 5,
    storePrice: 380,
    castAnim: 'special',
  },
];

export const species: PalSpecies = {
  id: 'galebird',
  name: 'Galebird',
  element: 'wind',
  locomotion: 'flying',
  description:
    'A wind-stitched swallow that treats gravity as a polite suggestion — the fastest wings in the valley.',
  baseStats: { maxHp: 36, attack: 12, defense: 4, speed: 8.0 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
