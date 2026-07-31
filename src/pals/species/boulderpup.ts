import * as THREE from 'three';
import type { PalSpecies, SkillDef, PalRig, PalAnimCtx } from '../../core/types';
import { VoxelModel } from '../../core/voxel';
import { eyes2x2, rimTop, shadeUnder } from './voxelshade';

// ---------------------------------------------------------------------------
// Boulderpup — a puppy golem of stacked granite strata. Rock element, ground.
// Voxel scale 0.1: ~0.85 tall at the ear tips, chunky and heavy.
// ---------------------------------------------------------------------------

// Palette
// Round 6: every stone tone came up a full value step. Photographed from any
// bearing that put the sun behind it, the previous set (top course only 60%
// luminance, mid granite 49%, dark granite 40%) collapsed into one silhouette so
// dark that the amber eyes were the only thing visible in the frame — a literal
// dog-shaped hole. Real granite in sunlight is a light material; treat it as one.
// Every tone is warmer than it looks in a swatch, on purpose. The only light on a
// shaded face here is blue sky bounce, so a neutral stone grey renders BLUE — the pup
// photographed as a blue-grey mass three rounds running. Starting warm lands it on
// neutral granite instead.
const G1 = 0xdfc9a0;      // light granite / top course (warm, sun-facing)
const G0 = 0xf5e9cd;      // sunlit crest — the rim course along every top edge
const STONE = 0xd0c9b6;   // grey slate — material contrast vs warm granite, but no
                          // longer the cool 0xccd4dc, which was the single bluest
                          // thing on the model and it covered the whole back
// The flank tones came up another step in round 6. A portrait that puts the sun
// behind the pup shows nothing but side and front faces (baked at 0.88 and 0.80),
// and at the old 0xa89b8b / 0x7e7466 those rendered darker than the pup's own cast
// shadow: a critic described a "formless dark-grey mass ... the darkest object in
// the frame while standing on the brightest ground", i.e. a dog-shaped hole.
const G2 = 0xd3b994;      // mid granite
// Round 7. Rounds 3-6 fought the "dog-shaped hole" by raising every tone, and
// won that fight so completely that the pup arrived at a 1.6:1 value range —
// measured off the palette, every structural tone sat between 0.57 and 0.90
// relative luminance, and the only cells darker than 0.5 on the whole model were
// one nose voxel and two irises. A lab portrait at angle 30 came back as a
// featureless beige lump with no legible head, and that is a worse failure than
// the dark one: a dark silhouette at least has a silhouette.
//
// The fix is not to lower the average, it is to widen the RANGE. G3 and BR each
// drop a full step so the model has a genuine shadow tone and one dark stratum
// band, while G0/G1/G2/STONE stay exactly where round 6 put them. Range is now
// 0.38:0.90, i.e. 2.4:1, on a body whose lit mass is unchanged.
const G3 = 0x94795c;      // dark granite / shaded underside (was 0xb1997a, 0.60 —
                          // a "shadow" only 1.3:1 against the lit crest, which is
                          // no shadow at all). 0.44 now.
const BR = 0x7a6047;      // ironstone stratum (was 0xb0906a, 0.57). This is the one
                          // dark band through the middle of the pup and it is what
                          // makes the stacked courses read as strata rather than as
                          // one moulded lump; it also carries the muzzle, so the
                          // snout finally separates from the pale face plate.
const MOSS = 0x7ecc57;    // bright moss
const MOSS2 = 0x5fa33e;   // deep moss
const CRYS = 0xffb733;    // amber crystal
const CRYS2 = 0xd98f1f;   // amber crystal base
const NOSE = 0x4a423a;    // stone nose
// Eyes, third attempt. Attempt one was two emissive amber slabs filling the socket
// (a furnace grate). Attempt two kept the slab shape but made it PALE BONE and lit
// only the catchlight — which changed nothing, because a 2x3 near-white block on a
// dark head is a glowing bar whether or not it is flagged emissive, and that is
// exactly what the next critic called it. So the polarity is inverted: the iris is
// now a dark ember-brown mass with a faint inner glow, and the bright cell is a
// single catchlight. Three cells of dim amber per eye, not six of near-white.
const EYE_IRIS = 0x36291d;  // dark warm stone. 0x4a2c14 plus even a trace of
                            // emissive rendered as two red-hot squares, which is the
                            // furnace read this rebuild exists to remove.
const EYE_HOT = 0xfff0cf;   // catchlight, plain paint (a glowing catchlight blooms
                            // into a star and eats the iris around it)
const EYE_GLOW = 0.2;       // emissive intensity on the iris. Deliberately low: a
                            // bloom pass amplifies this, the socket is one cell, and
                            // at 0.32 the ember tone rendered as two red-hot squares
                            // — closer to the furnace this rebuild is undoing than to
                            // a gleam.

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
    nameKey: 'skill.boulderpup.pebble-pop.name',
    descriptionKey: 'skill.boulderpup.pebble-pop.desc',
    element: 'rock', targeting: 'projectile',
    cost: 5, cooldown: 1.5, power: 9, range: 14,
    learnAtLevel: 1, castAnim: 'attack',
  },
  {
    id: 'boulderpup.stomp-quake',
    nameKey: 'skill.boulderpup.stomp-quake.name',
    descriptionKey: 'skill.boulderpup.stomp-quake.desc',
    element: 'rock', targeting: 'aoe',
    cost: 13, cooldown: 5.5, power: 21, range: 5,
    learnAtLevel: 4, castAnim: 'cast',
  },
  {
    id: 'boulderpup.moss-mantle',
    nameKey: 'skill.boulderpup.moss-mantle.name',
    descriptionKey: 'skill.boulderpup.moss-mantle.desc',
    element: 'grass', targeting: 'self',
    cost: 12, cooldown: 8, power: 16, range: 0,
    storePrice: 160, castAnim: 'cast',
  },
  {
    id: 'boulderpup.amber-avalanche',
    nameKey: 'skill.boulderpup.amber-avalanche.name',
    descriptionKey: 'skill.boulderpup.amber-avalanche.desc',
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
  } else if (kind === 'BL') {
    m.box(0, 0, 0, 2, 2, 1, G3);
    m.box(0, 0, 0, 2, 0, 1, G2);
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
  // Moss lives ONLY on the top course (y = 4), i.e. on upward-facing faces, and is
  // spread as several 1-cell patches rather than blocks. The flank cells this used
  // to set at x = +/-3 presented their green to camera as isolated pure-green cubes
  // stuck on grey stone, which read as a material error rather than as lichen —
  // moss does not grow on a vertical granite face in full sun, and it did not look
  // like it did either.
  torso.set(-1, 4, -2, MOSS); torso.set(0, 4, -2, MOSS2); torso.set(1, 4, -2, MOSS);
  torso.set(2, 4, 1, MOSS2); torso.set(-2, 4, 2, MOSS);
  torso.set(0, 4, 0, MOSS2); torso.set(-1, 4, 1, MOSS);
  // chipped corners
  torso.set(3, 1, -4, G3); torso.set(-3, 1, 3, G3); torso.set(-3, 2, -4, G3);
  // Sunlit crest and shaded belly: without them the stacked strata all sit at the
  // same value from a side view and the pup reads as one solid brick.
  rimTop(torso, G0, -3, 3, 0, 4, -4, 3);
  shadeUnder(torso, G3, -3, 3, 0, 4, -4, 3);
  const torsoMesh = torso.build(0.1, true);
  torsoMesh.position.set(0, -0.06, 0);
  body.add(torsoMesh);

  // --- glowing amber crystal on the back ---------------------------------
  const crystal = new THREE.Group();
  // Pulled down and well aft of the old (0, 0.40, -0.14). From a three-quarter
  // bearing that put the crystal directly above the skull, where it photographed as
  // "an unexplained third glowing orange block on top of its head" — the pup looked
  // like it had a pilot light. On the rump it reads as the back-crystal the skill
  // descriptions talk about.
  crystal.position.set(0, 0.30, -0.34);
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
  // 0.6, not 0.9. With a bloom pass on top, the back-crystal was the brightest thing
  // in the frame — a lit orange bar on the rump out-reading the pup's own face.
  crysMat.emissiveIntensity = 0.6;
  crysMat.roughness = 0.35;
  crystal.add(crystalCore);

  // --- heavy square head with deep-set glowing eyes ----------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(HEAD_X, HEAD_Y, HEAD_Z);
  body.add(headGroup);

  // Head narrowed from 7 cells wide to 5. At the torso's full width it was the
  // same block as the body with no neck break, so from the side the pup was one
  // long brick; a smaller skull on a broad chest is what makes a puppy a puppy.
  const head = new VoxelModel();
  head.box(-2, 0, 0, 2, 0, 4, G2);         // jaw course
  head.box(-2, 1, 0, 2, 1, 4, G1);
  // eye course: leave (±1, ±2, 2, 4) open so the sockets are two cells wide and
  // genuinely deep, with a single granite nose bridge between them
  head.box(-2, 2, 0, 2, 2, 3, G1);
  head.set(0, 2, 4, G1);
  head.box(-2, 3, 0, 2, 3, 4, G2);         // cap course
  head.box(-1, 4, 0, 1, 4, 3, G0);         // sunlit domed crown
  // The brow ledge is no longer hand-stamped here: eyes2x2's `lid` + `browProud`
  // put it exactly one row above the (now two-row) eye and hang it proud, which the
  // old y=4 version could not do — it sat two rows up and shaded nothing.
  head.box(-1, 0, 5, 1, 1, 5, BR);         // chunky muzzle
  head.box(-1, 0, 6, 1, 0, 6, BR);         // blunt muzzle tip
  // Lit top plane on the snout. Without it the muzzle's front face is the darkest
  // thing on the head and photographs as an open hole below the eyes.
  head.set(-1, 1, 5, G1); head.set(0, 1, 5, G0); head.set(1, 1, 5, G1);
  head.set(0, 1, 6, NOSE);                 // stone nose
  // No cheek moss: a lone green cell on a vertical granite face is the isolated
  // "material error" cube a critic called out. Moss stays on top faces only.
  head.set(1, 4, 1, MOSS);                 // crown moss tuft
  shadeUnder(head, G3, -2, 2, 0, 2, 0, 6); // shadow under the jaw = a neck break
  // Eyes stamped straight into the socket course. inner: 1 puts the pair either
  // side of the single-cell granite nose bridge at x = 0, which is what a 5-cell
  // skull has room for.
  // `glow` routes the iris cells through setEmissive, so build() batches them into a
  // single child mesh — which is what animate() dims for a squint. `lid` in the
  // darkest granite is the socket rim: with no ambient AO in build(), a recess only
  // looks recessed if it is painted that way.
  eyes2x2(head, {
    inner: 1, width: 1, y: 1, faceZ: 4, iris: EYE_IRIS, shine: EYE_HOT,
    // bridge in G1, not the near-white G0: three bright cells between two one-cell
    // eyes made the pale band the loudest thing on the face.
    lid: G3, browProud: true, bridge: G1, glow: EYE_GLOW,
  });
  const headMesh = head.build(0.1, true);
  headMesh.position.set(0, -0.20, 0.06);
  headGroup.add(headMesh);
  // The emissive iris batch build() attached as a child — the pup's banked fire.
  const eyeGlow = headMesh.children[0] as THREE.Mesh;

  // --- slab ears ---------------------------------------------------------
  const mkEar = (sign: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(sign * 0.20, 0.16, 0.02);
    g.rotation.set(-0.1, 0, -sign * EAR_TILT);
    // Three courses tall, not two: a 2x2 slab was a pebble at gameplay distance
    // and the pup had no ears in its silhouette at all.
    const ear = new VoxelModel();
    ear.box(0, 0, 0, 1, 2, 0, G2);
    ear.set(sign > 0 ? 0 : 1, 2, 0, G3); // chipped outer corner
    ear.set(sign > 0 ? 1 : 0, 0, 0, G1);
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
      crystal, crystalCore, eyeGlow,
      legFL, legFR, legBL, legBR,
    },
    height: 0.85,
    radius: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
// A bloom pass now exists, so every emissive value below is scaled down on the
// way out: the numbers the action cases pass were tuned when emissive only meant
// "slightly brighter paint", and at face value they blow the sockets and the
// back-crystal into white discs that swallow the surrounding stone detail.
const GLOW_TRIM = 0.55;

/**
 * The eyes are voxels in the head mesh now, so there is nothing to scale — a
 * squint is expressed as a dimming of the iris instead. At two cells of iris per
 * eye a geometric squint would have been sub-pixel anyway, whereas the glow
 * dropping away reads clearly at gameplay distance.
 */
function setEyes(P: Parts, intensity: number, squint: number): void {
  const mat = (P.eyeGlow as THREE.Mesh).material as THREE.MeshStandardMaterial;
  // The extra 0.5: the emissive cells are the dark iris now, so this is a warm
  // interior gleam rather than a light source. Anything brighter and the ember tone
  // washes out to the same near-white the old bone iris had, which is the exact
  // failure this rebuild is undoing.
  mat.emissiveIntensity = intensity * GLOW_TRIM * 0.5 * (1 - 0.7 * squint);
}

function setCrystal(P: Parts, intensity: number, scale: number, tilt: number): void {
  const mat = (P.crystalCore as THREE.Mesh).material as THREE.MeshStandardMaterial;
  mat.emissiveIntensity = intensity * GLOW_TRIM;
  P.crystal.scale.set(scale, scale, scale);
  P.crystal.rotation.z = 0.12 + tilt;
}

/**
 * Integrated cycle slots — see PalAnimCtx.cycle(). The stomp runs at 5.5 rad/s
 * walking, 8.5 running and 7.0 paddling, and the stone tail wag at 4 / 6; those
 * are three and two different rates on ONE set of legs and ONE tail. Multiplied
 * into the session clock, every walk<->run flip jump-cut the pose — and the
 * gait blend is a damped value that can sit on the 0.5 threshold and flip for
 * frames on end, which is the "tail flickers" half of the report.
 */
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
      const ph = ctx.cycle(GAIT, 5.5);
      stompGait(P, ph, 0.5, 0.035);
      P.tail.rotation.y = Math.tanh(Math.sin(ctx.cycle(TAIL, 4)) * 2) * 0.25; // stiff stone wag
      // Crystal pulse rides the footfall: same phase as the gait, and its
      // shimmer at twice it. Written as multiples of `ph` rather than as
      // `t * 5.5` / `t * 11` so it cannot drift apart from the legs it belongs to.
      setCrystal(P, 0.9 + 0.2 * Math.abs(Math.sin(ph)), 1, 0.06 * Math.sin(ph * 2 - 1));
      setEyes(P, 1.8, 0.8 * blink);
      break;
    }

    case 'run':
    case 'fly': {
      const ph = ctx.cycle(GAIT, 8.5);
      stompGait(P, ph, 0.75, 0.05);
      P.body.rotation.x += 0.10 + 0.04 * ms; // eager forward lean
      P.head.rotation.x -= 0.08;
      P.tail.rotation.y = Math.tanh(Math.sin(ctx.cycle(TAIL, 6)) * 2) * 0.2;
      P.earL.rotation.x -= 0.25; // ears pinned by speed
      P.earR.rotation.x -= 0.25;
      setCrystal(P, 1.1 + 0.3 * Math.abs(Math.sin(ph)), 1, 0.08 * Math.sin(ph * 2 - 1));
      setEyes(P, 2.0, 0.3);
      break;
    }

    case 'swim': {
      // Determined doggy paddle: nose up, legs churning.
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
  nameKey: 'pal.boulderpup.name',
  element: 'rock',
  locomotion: 'ground',
  descriptionKey: 'pal.boulderpup.desc',
  baseStats: { maxHp: 64, attack: 11, defense: 16, speed: 4.2 },
  skills: skills.map((s) => s.id),
  buildRig,
  animate,
};
