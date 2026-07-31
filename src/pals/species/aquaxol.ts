import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Aquaxol — a perpetually smiling amphibious axolotl with party-streamer gills.
// Voxel scale 0.1 (1 cell = 10 cm). Model faces +Z. Root origin at ground /
// water level. Swims with lateral body undulation; waddles on its belly ashore.
// ---------------------------------------------------------------------------

const S = 0.1;

// Palette
const AQUA = 0x79d4e4;      // soft aqua-blue body
const AQUA_LIT = 0xa8ecf5;  // sunlit crest along back and crown
const AQUA_DEEP = 0x4a9db8; // mottled back spots / shaded underside
const BELLY = 0xd8f4f2;     // pale belly / chin / toes
// Gill fronds are SOFT CORAL now, not hot pink. Both fans always painted from
// the same two constants, so the "purple frill vs bubblegum frill" a critic saw
// was never a material mismatch — it was one fan in sun and one in shade, and a
// pink that saturated at 0xf87fb4 swings all the way to violet when the only light
// on it is blue sky bounce. Coral has enough red left in shadow to stay coral, and
// it stops fighting the teal body.
const GILL = 0xf29391;      // coral gill fronds
const GILL_TIP = 0xffc2ae;  // lighter, warmer frond tips
const FIN = 0xb5e9f0;       // translucent-looking fin rim
// The eye is a DARK mass on a light face, not the other way round. The previous
// build's near-white 2x3 iris was twelve cream cells on a five-by-four face plate —
// 60% of the face — so a critic looking at the portrait saw "a huge cream cube ...
// it reads as a floating mask", and the two dark pupils in it became the only
// feature. Dark teal keeps the water hue instead of punching a black hole.
const IRIS = 0x14323f;      // dark teal iris
const SHINE = 0xf4ffff;     // single catchlight cell
const MOUTH = 0x33566b;     // short inset smile line
const BLUSH = 0xf7b0a4;

// Base pose constants (must match buildRig)
const BODY_Y = 0.24;
const HEAD_Y = 0.1;
// 0.26, not 0.32. Six centimetres of z is the difference between a skull sitting ON
// the shoulders and a skull cantilevered in front of them, and at 0.32 a front-on
// portrait had the head covering the whole chest.
const HEAD_Z = 0.26;
// Gill frond fan: base lift (rotZ) and back-sweep (rotY) per frond, front→back
const GZ: readonly number[] = [0.55, 0.38, 0.2];
const GY: readonly number[] = [0.25, 0.5, 0.75];
const GR = ['gillR1', 'gillR2', 'gillR3'] as const;
const GL = ['gillL1', 'gillL2', 'gillL3'] as const;
const LEG_SPLAY = 0.3; // stubby legs angle outward

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const ezOut = (t: number): number => 1 - (1 - t) ** 3;
const phase = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * Integrated cycle slots — see PalAnimCtx.cycle(). Every one of these
 * frequencies moves with the gait blend, so multiplying them into the session
 * clock made the pose teleport whenever the pal changed pace.
 */
const GAIT = 0;   // legs + waddle roll, shared by the waddle and the swim
const FROND = 1;  // the frond ripple, which tracks the gait rate at its own scale

function makeTorso(): THREE.Mesh {
  const m = new VoxelModel();
  // Torso grown 2.8/2.2/3.2 -> 3.4/2.6/3.6. The head is 7 cells wide however you
  // shape it, and a 5-cell-wide body behind it is exactly why aquaxol
  // photographed as a head with a scrap of body and one foot: the shoulder and hip
  // masses were narrower than the skull, so they hid behind it from every bearing.
  m.ellipsoid(0, 2.2, 0, 3.4, 2.6, 3.6, AQUA);
  m.ellipsoid(0, 0.9, 0, 3.0, 1.5, 3.2, BELLY);  // soft belly
  // Dorsal crest raised to two rows: with the skull now sitting in front of the
  // chest, the crest is what shows ABOVE the head line and tells you there is a body
  // back there at all.
  m.box(0, 5, -2, 0, 5, 2, FIN);
  m.box(0, 6, -1, 0, 6, 1, FIN);
  // mottled spots along the back
  m.set(2, 3, 1, AQUA_DEEP);
  m.set(-2, 3, -1, AQUA_DEEP);
  m.set(1, 4, 0, AQUA_DEEP);
  m.set(-1, 4, 0, AQUA_DEEP);
  shadeUnder(m, AQUA_DEEP, -3, 3, 0, 2, -4, 4);
  // Sunlit crest along the back, so the bigger barrel reads as a barrel and not a
  // flat aqua field.
  rimTop(m, AQUA_LIT, -3, 3, 2, 5, -4, 4);
  return m.build(S, true);
}

function makeHead(): THREE.Mesh {
  const m = new VoxelModel();
  // FIVE cells across, down from seven. A seven-wide face plate on a creature this
  // size is a signboard: it eclipsed the entire torso in a head-on portrait, which
  // is the whole reason aquaxol read as a floating head with one foot. The barrel
  // behind it is seven wide, so the body now out-measures the skull from any bearing.
  // Volume down another ~25% (2.6/2.2/2.2 -> 2.4/1.9/2.0). Cell width is unchanged
  // at five, but the skull is a row shallower and a row less deep, which is what
  // actually stops it eclipsing the barrel from a head-on bearing.
  m.ellipsoid(0, 2, 1, 2.4, 1.9, 2.0, AQUA);      // wide friendly head
  m.ellipsoid(0, 0.4, 1.6, 2.0, 1.0, 1.5, BELLY); // chin, underside only
  m.box(-2, 1, 3, 2, 4, 3, AQUA);                  // flat face plate
  // The plate is painted AFTER the chin on purpose: it covers the pale chin at the
  // face plane and leaves it visible only underneath. The old build let the chin
  // ellipsoid own the whole lower face, which with a proud dark mouth on top of it
  // photographed as a tooth-plate and a bib rather than as a jaw.
  rimTop(m, AQUA_LIT, -2, 2, 0, 5, -2, 3);
  // Mouth: a SHORT dark line inset flush into the face plate, three cells wide.
  // It used to be five cells stamped one cell PROUD at z=4, which is what turned it
  // into a slab bolted across the muzzle.
  // A CURVED smile, not a straight bar: centre cell low, the two outer cells one row
  // up. Three cells in a row at one height is a letterbox slot; stepping the corners
  // up is the whole difference between a slot and a grin, and this species is
  // supposed to be perpetually delighted.
  // Pale field first, then the smile on top of it. Painted the other way round the
  // field erased the smile's own centre cell and left two floating corner dashes.
  // A dark iris needs a light neighbour to read as an eye rather than a smudge, and
  // on a face that is in shade in most portraits the coat teal cannot supply it.
  for (let x = -2; x <= 2; x++) { m.set(x, 0, 3, BELLY); m.set(x, 1, 3, BELLY); }
  m.set(0, 0, 3, MOUTH);
  m.set(1, 1, 3, MOUTH); m.set(-1, 1, 3, MOUTH);
  // width: 1 on a five-cell face — the classic dot / bridge / dot face, and about a
  // fifth of the head's width, which is the proportion this macro aims for. inner: 1
  // and NOT 2: at 2 the single eye column sits on the plate's outer edge, and the
  // real-game portrait came back with the near eye swallowed by the head's own
  // silhouette and the far one gone entirely.
  eyes2x2(m, {
    inner: 1, width: 1, y: 2, faceZ: 3, iris: IRIS, shine: SHINE,
    // lid in mid AQUA, not AQUA_DEEP: the front of a pal's head is in shade in most
    // portraits, and a deep tone there merged with the dark iris into one black band.
    lid: AQUA, bridge: BELLY, cheek: BLUSH,
  });
  return m.build(S, true);
}

/** One feathery gill frond; dir=+1 grows toward +X (right), -1 toward -X. */
function makeFrond(dir: number): THREE.Mesh {
  const m = new VoxelModel();
  m.set(0, 0, 0, GILL);
  m.set(dir * 1, 0, 0, GILL);
  m.set(dir * 2, 0, 0, GILL);
  m.set(dir * 3, 0, 0, GILL_TIP);
  m.set(dir * 1, 0, 1, GILL_TIP);   // forward wisp
  m.set(dir * 2, 0, -1, GILL_TIP);  // trailing wisp
  return m.build(S, false); // keep pivot at the root of the frond
}

function makeLeg(): THREE.Mesh {
  const m = new VoxelModel();
  m.box(0, 0, 0, 1, 1, 1, AQUA);
  m.set(0, 0, 2, BELLY); // tiny toes
  m.set(1, 0, 2, BELLY);
  return m.build(S, true);
}

function makeTailStem(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 1.5, -1.4, 1.4, 1.5, 1.9, AQUA);
  return m.build(S, true);
}

function makeTailPaddle(): THREE.Mesh {
  const m = new VoxelModel();
  m.ellipsoid(0, 2, -1.8, 0.7, 2.6, 2.4, FIN);   // thin fin blade
  m.ellipsoid(0, 2, -1.5, 0.8, 1.7, 1.7, AQUA);  // fleshy core, rim stays pale
  return m.build(S, true);
}

function buildRig(): PalRig {
  const root = new THREE.Group();

  const body = new THREE.Group();
  body.position.set(0, BODY_Y, 0);
  root.add(body);

  const torso = makeTorso();
  torso.position.set(0, -0.14, 0);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, HEAD_Z);
  body.add(head);
  const headMesh = makeHead();
  // 0.05, not 0.10: dropping the proud mouth row shortened the model by one cell in
  // z, and build() re-centres on the bounding box, so the head would otherwise
  // creep forward off the shoulders.
  headMesh.position.set(0, -0.14, 0.05);
  head.add(headMesh);

  // Three pink gill fronds per side, fanned along the back of the head
  const gills: Record<string, THREE.Group> = {};
  const gz = [0.06, -0.04, -0.12];
  const gy = [0.26, 0.24, 0.2];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Group();
    r.position.set(0.16, gy[i], gz[i]); // a full cell INSIDE the 5-cell skull, so no
                                        // frond pose can open a gap at the root
    r.rotation.set(0, GY[i], GZ[i]);
    head.add(r);
    r.add(makeFrond(1));
    gills[GR[i]] = r;

    const l = new THREE.Group();
    l.position.set(-0.16, gy[i], gz[i]);
    l.rotation.set(0, -GY[i], -GZ[i]);
    head.add(l);
    const lFrond = makeFrond(-1);
    lFrond.position.x = -0.1; // mirror the center=false voxel-grid pivot offset
    l.add(lFrond);
    gills[GL[i]] = l;
  }

  const mkLegGroup = (x: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, -0.04, z);
    g.rotation.z = x > 0 ? LEG_SPLAY : -LEG_SPLAY;
    body.add(g);
    const mesh = makeLeg();
    mesh.position.set(0, -0.2, 0);
    g.add(mesh);
    return g;
  };
  // Pushed out from 0.18 to 0.26: the widened barrel swallowed the old leg
  // positions whole, which is how a portrait ended up showing a single foot wedge.
  const legFL = mkLegGroup(0.26, 0.24);
  const legFR = mkLegGroup(-0.26, 0.24);
  const legBL = mkLegGroup(0.26, -0.22);
  const legBR = mkLegGroup(-0.26, -0.22);

  const tailBase = new THREE.Group();
  tailBase.position.set(0, 0.02, -0.26);
  body.add(tailBase);
  const stem = makeTailStem();
  stem.position.set(0, -0.1, -0.1);
  tailBase.add(stem);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, 0.02, -0.28);
  tailBase.add(tailTip);
  const paddle = makeTailPaddle();
  paddle.position.set(0, -0.18, -0.08);
  tailTip.add(paddle);

  return {
    root,
    parts: {
      body, head, legFL, legFR, legBL, legBR, tailBase, tailTip,
      gillR1: gills.gillR1, gillR2: gills.gillR2, gillR3: gills.gillR3,
      gillL1: gills.gillL1, gillL2: gills.gillL2, gillL3: gills.gillL3,
    },
    height: 0.76,
    radius: 0.48,
  };
}

function animate(rig: PalRig, ctx: PalAnimCtx): void {
  const p = rig.parts;
  const t = ctx.time;
  const at = ctx.actionTime;
  const ms = clamp01(ctx.moveSpeed);
  const br = Math.sin(t * 2.1);

  // Pose state, written in full every frame.
  let bpx = 0, bpy = BODY_Y + 0.004 * br, bpz = 0;
  let brx = 0, bry = 0, brz = 0;
  let bsx = 1, bsy = 1 + 0.012 * br, bsz = 1;
  let hrx = 0, hry = 0, hrz = 0, hpy = HEAD_Y, hpz = HEAD_Z;
  let flrx = 0, frrx = 0, blrx = 0, brrx = 0, legSplayMul = 1;
  let tbx = 0, tby = 0, ttx = 0, tty = 0;
  // Gill controls: extra lift (flare), extra back-sweep, ripple wave
  let gillFlare = 0, gillBack = 0, gillWaveAmp = 0.1, gillFreq = 1.8, gillSweepAmp = 0.06, gillPhase = 0;

  switch (ctx.action) {
    case 'idle': {
      bsy = 1 + 0.028 * br;
      bsx = bsz = 1 - 0.012 * br;
      hrx = 0.05 * Math.sin(t * 1.5 + 0.4);
      hry = 0.08 * Math.sin(t * 0.23);
      // contented head tilt pulses
      hrz = 0.04 * Math.sin(t * 0.7) + 0.22 * Math.max(0, Math.sin(t * 0.31 + 2.1)) ** 12;
      gillWaveAmp = 0.14;
      gillFlare = 0.25 * Math.max(0, Math.sin(t * 0.5 + 2)) ** 10; // occasional proud flare
      tby = 0.15 * Math.sin(t * 1.3);
      tty = 0.2 * Math.sin(t * 1.3 - 0.9);
      // sleepy toe wiggles
      flrx = 0.08 * Math.sin(t * 1.9);
      brrx = 0.08 * Math.sin(t * 1.9 + 2);
      break;
    }
    case 'walk':
    case 'run': { // the famous belly waddle
      const isRun = ctx.action === 'run';
      // 5.5-8.5 rad/s waddling, 8-11 at a run. Integrated: measured with
      // tools/test-palanim.mjs, `t * f` put 1.69 rad of leg swing into one
      // frame as the waddle spun up; the integrated cycle peaks at 0.29.
      const f = (isRun ? 8 : 5.5) + 3 * ms;
      const ph = ctx.cycle(GAIT, f);
      const amp = (isRun ? 0.9 : 0.65) * (0.5 + 0.5 * ms);
      brz = (isRun ? 0.17 : 0.13) * Math.sin(ph);       // roll waddle
      bry = 0.09 * Math.sin(ph - 0.4);                  // butt wiggle
      bpy += 0.02 * Math.sin(ph * 2) + (isRun ? 0.035 * Math.max(0, Math.sin(ph * 2 + 0.5)) : 0);
      bsy = 1 + 0.04 * Math.sin(ph * 2 + 0.8);
      bsx = bsz = 1 - 0.4 * (bsy - 1);
      flrx = brrx = amp * Math.sin(ph);
      frrx = blrx = amp * Math.sin(ph + Math.PI);
      hrz = -0.1 * Math.sin(ph);                        // head counter-roll
      hrx = 0.05 * Math.sin(ph * 2) - 0.04 * ms;
      // tail drags side to side; gills flop with a springy lag
      tby = 0.4 * Math.sin(ph - 1.0);
      tty = 0.55 * Math.sin(ph - 1.7);
      gillWaveAmp = 0.24;
      gillFreq = f;
      gillPhase = -1.2;
      gillSweepAmp = 0.1;
      break;
    }
    case 'swim':
    case 'fly': { // graceful lateral undulation (fly never happens; swim it)
      const f = 4.5 + 3.5 * ms;
      const ph = ctx.cycle(GAIT, f);
      bry = 0.1 * Math.sin(ph);
      brz = 0.07 * Math.sin(ph - 0.6);                  // gentle banking roll
      brx = 0.03 + 0.04 * Math.sin(t * 1.5);
      bpy += 0.03 * Math.sin(t * 2.1);
      tby = 0.5 * Math.sin(ph - 0.9);
      tty = 0.7 * Math.sin(ph - 1.7);
      // legs sweep back and flutter
      legSplayMul = 0.3;
      flrx = 1.0 + 0.15 * Math.sin(ph * 2);
      frrx = 1.0 + 0.15 * Math.sin(ph * 2 + 1.2);
      blrx = 1.0 + 0.15 * Math.sin(ph * 2 + 2.4);
      brrx = 1.0 + 0.15 * Math.sin(ph * 2 + 3.6);
      hrx = 0.05 * Math.sin(ph - 0.4);
      hry = 0.08 * Math.sin(ph + 0.5);
      // gills stream back and ripple in the flow
      gillBack = 0.45;
      gillWaveAmp = 0.26;
      gillFreq = f;
      gillSweepAmp = 0.16;
      break;
    }
    case 'attack': { // wind up, then a surprisingly quick chomp-lunge
      const wind = smooth(phase(at, 0, 0.14));
      const lunge = ezOut(phase(at, 0.14, 0.3));
      const rec = smooth(phase(at, 0.45, 0.8));
      const k = -0.6 * wind * (1 - lunge) + lunge * (1 - rec);
      const kp = Math.max(0, k);
      bpz = 0.18 * k;
      bpy += 0.02 * kp;
      brx = 0.1 * k;
      bsz = 1 + 0.15 * kp;
      bsx = 1 - 0.06 * kp;
      hrx = 0.25 * k;
      hpz = HEAD_Z + 0.07 * kp;
      gillFlare = 0.6 * kp;                             // gills snap wide on the bite
      gillBack = 0.3 * wind * (1 - lunge);
      flrx = frrx = -0.5 * kp + 0.4 * wind * (1 - lunge);
      blrx = brrx = 0.5 * kp;
      tby = -0.35 * k;                                  // tail counter-whip
      tty = -0.45 * k;
      break;
    }
    case 'cast': { // rears up, gills fanned wide and shimmering with power
      const rise = ezOut(clamp01(at / 0.4));
      const tremor = 0.5 * Math.sin(t * 12) + 0.5 * Math.sin(t * 17);
      brx = -0.45 * rise + 0.02 * tremor * rise;
      bpy += 0.08 * rise;
      hrx = 0.28 * rise;
      flrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5) * rise;
      frrx = -1.1 * rise + 0.2 * Math.sin(t * 6.5 + Math.PI) * rise;
      blrx = brrx = 0.4 * rise;
      tbx = -0.3 * rise;                                // tail braces on the ground
      tby = 0.06 * Math.sin(t * 8);
      gillFlare = 0.7 * rise;
      gillWaveAmp = 0.1 + 0.3 * rise;
      gillFreq = 9;
      break;
    }
    case 'special': { // a joyful barrel roll with full gill flare
      const T = 0.8;
      const k2 = clamp01(at / T);
      const tuck = Math.sin(Math.PI * k2);
      const land = Math.sin(Math.PI * phase(at, T, T + 0.22)) * (1 - smooth(phase(at, T + 0.22, T + 0.55)));
      brz = Math.PI * 2 * smooth(k2);
      bpy += 0.22 * tuck;
      bsy = 1 - 0.2 * land;
      bsx = bsz = 1 + 0.11 * land;
      hrx = -0.15 * tuck + 0.1 * land;
      flrx = frrx = -0.6 * tuck + 0.3 * land;
      blrx = brrx = 0.8 * tuck - 0.3 * land;
      tby = 0.6 * Math.sin(at * 14) * tuck;
      tty = 0.8 * Math.sin(at * 14 - 0.7) * tuck;
      gillFlare = 0.9 * tuck + 0.3 * land;
      gillWaveAmp = 0.3;
      gillFreq = 10;
      break;
    }
    case 'hurt': {
      const d = Math.exp(-3.5 * at);
      bpx = 0.035 * Math.sin(at * 42) * d;
      bpy -= 0.04 * d;
      bpz = -0.08 * d;
      brz = 0.07 * Math.sin(at * 35 + 1) * d;
      hrx = -0.2 * d;
      hrz = 0.08 * Math.sin(at * 28) * d;
      gillFlare = -0.45 * d;                            // gills clamp tight
      gillBack = 0.5 * d;
      flrx = frrx = 0.25 * d;
      blrx = brrx = -0.25 * d;
      tbx = 0.3 * d;                                    // tail curls down
      bsy = 1 - 0.08 * d;
      bsx = bsz = 1 + 0.04 * d;
      break;
    }
    case 'happy': { // delighted little hops, gills fluttering like streamers
      const hf = 5;
      const hop = Math.abs(Math.sin(at * hf));
      bpy += 0.1 * hop;
      bsy = 0.88 + 0.24 * hop;
      bsx = bsz = 1 - 0.5 * (bsy - 1);
      bry = 0.3 * Math.sin(at * 2.4);
      hrz = 0.25 * Math.sin(at * 2.4 + 1);
      hrx = -0.08;
      flrx = 0.3 * Math.sin(at * 10);
      frrx = 0.3 * Math.sin(at * 10 + Math.PI);
      blrx = 0.3 * Math.sin(at * 10 + 1.5);
      brrx = 0.3 * Math.sin(at * 10 + 1.5 + Math.PI);
      tby = 0.6 * Math.sin(at * 13);
      tty = 0.8 * Math.sin(at * 13 - 0.7);
      gillFlare = 0.3 + 0.2 * Math.sin(at * 5);
      gillWaveAmp = 0.35;
      gillFreq = 11;
      break;
    }
  }

  p.body.position.set(bpx, bpy, bpz);
  p.body.rotation.set(brx, bry, brz);
  p.body.scale.set(bsx, bsy, bsz);
  p.head.position.set(0, hpy, hpz);
  p.head.rotation.set(hrx, hry, hrz);
  p.legFL.rotation.set(flrx, 0, LEG_SPLAY * legSplayMul);
  p.legFR.rotation.set(frrx, 0, -LEG_SPLAY * legSplayMul);
  p.legBL.rotation.set(blrx, 0, LEG_SPLAY * legSplayMul);
  p.legBR.rotation.set(brrx, 0, -LEG_SPLAY * legSplayMul);
  p.tailBase.rotation.set(tbx, tby, 0);
  p.tailTip.rotation.set(ttx, tty, 0);

  // Gill fronds: mirrored fan, each with its own ripple phase.
  //
  // `gillFreq` is 1.8 rad/s at rest and the whole gait frequency while moving,
  // so it is one of the frequencies that MOVES and has to be integrated. The
  // sweep runs at 0.8x the ripple; taking that as a constant multiple of the
  // integrated phase keeps the exact rate ratio and stays continuous.
  const gw = ctx.cycle(FROND, gillFreq);
  for (let i = 0; i < 3; i++) {
    const lift = GZ[i] + gillFlare + gillWaveAmp * Math.sin(gw + gillPhase + i * 0.9);
    const sweep = GY[i] + gillBack + gillSweepAmp * Math.sin(gw * 0.8 + i * 0.7);
    p[GR[i]].rotation.set(0, sweep, lift);
    p[GL[i]].rotation.set(0, -sweep, -lift);
  }
}

export const skills: SkillDef[] = [
  {
    id: 'aquaxol.bubble-pop',
    name: 'Bubble Pop',
    description: 'Blows a wobbling bubble that bursts with a surprisingly rude POP.',
    element: 'water',
    targeting: 'projectile',
    cost: 5,
    cooldown: 1.6,
    power: 10,
    range: 14,
    learnAtLevel: 1,
    castAnim: 'attack',
  },
  {
    id: 'aquaxol.tide-swirl',
    name: 'Tide Swirl',
    description: 'Spins its paddle tail to whip up a chilly whirlpool around itself.',
    element: 'water',
    targeting: 'aoe',
    cost: 12,
    cooldown: 5,
    power: 17,
    range: 3.8,
    learnAtLevel: 4,
    castAnim: 'cast',
  },
  {
    id: 'aquaxol.soothing-slime',
    name: 'Soothing Slime',
    description: 'Sheds a film of regenerative slime that patches up nearby friends. Slightly gross, extremely effective.',
    element: 'water',
    targeting: 'support',
    cost: 16,
    cooldown: 8,
    power: 22,
    range: 6,
    storePrice: 220,
    castAnim: 'special',
  },
  {
    id: 'aquaxol.hydro-jet',
    name: 'Hydro Jet',
    description: 'Gulps, aims, and fires a pressure-washer stream of water. Do not stand in front of the smile.',
    element: 'water',
    targeting: 'beam',
    cost: 20,
    cooldown: 9,
    power: 32,
    range: 12,
    storePrice: 320,
    castAnim: 'cast',
  },
];

export const species: PalSpecies = {
  id: 'aquaxol',
  name: 'Aquaxol',
  element: 'water',
  locomotion: 'amphibious',
  description:
    'A perpetually smiling axolotl that waddles on land and ripples through water, gills fluttering like party streamers.',
  baseStats: { maxHp: 54, attack: 9, defense: 8, speed: 3.6 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
