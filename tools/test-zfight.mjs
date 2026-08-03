// Z-FIGHTING GUARD — the one probe in tools/ that never opens a browser.
//
// Every model in this game is a stack of separate voxel meshes hung off a rig:
// a head on a neck, a mantle on a torso, an arm on a shoulder. Inside ONE
// VoxelModel a shared face is never emitted — `build()` culls a face whose
// neighbouring cell is painted — but that culling test cannot see across
// models, and two models CAN be painted onto the same world plane. When they
// are, the depth buffer has to choose between two surfaces at the same depth,
// and it chooses differently either side of a quad's triangle diagonal: what
// the player sees is a hard diagonal seam swimming across a body part as the
// camera moves. That is what Gain's hood did to the back of his own hair.
//
// THE TRAP IS THE SHARED GRID, and it is worth stating plainly because it is
// not obvious from a builder file. `VoxelModel.build` puts every face on a
// multiple of the voxel scale S, re-based on the model's own bounds. So two
// parts land on the SAME world grid — and every one of their faces is a
// candidate pair — whenever the joint between them is a whole multiple of S in
// that axis. Gain's neck is at 1.32 with S = 0.1, which is why nothing of his
// z-fights in Y; his head is centred in x and z, which is why everything of his
// that z-fought did so in X and Z. A joint offset is therefore a rendering
// decision as much as a pose one, and this tool is what notices.
//
// WHAT IT MEASURES. Every rig in the game — the hero, all ten beast species,
// every NPC — is built here in plain three.js (no WebGL: `VoxelModel.build`
// only fills BufferGeometry, so the whole check is arithmetic) and posed
// through its own animator over a sweep of poses. For each pose it looks for
// pairs of quads from DIFFERENT meshes that
//
//   * face the same way (dot of world normals > 0.999 — opposite-facing pairs
//     cannot fight, because one of the two is back-face culled),
//   * lie on the same plane to within GAP,
//   * actually overlap once projected onto it,
//   * are EXPOSED rather than buried inside the body (see `exposedFraction`),
//   * and are a DIFFERENT COLOUR on each side (see CONTRAST).
//
// The last two are what make the output worth reading. Bodies here are
// assembled by shoving models into one another, so coincident faces are
// everywhere; a `seam` is the whole conjunction, and it is the only thing the
// run fails on. Everything else lands in `hiddenPairs`, reported and never
// asserted on. `worstSeamArea` is the number to triage by — 0.01 m2 is one
// whole voxel face of two colours flickering against each other.
//
// THE POSE SWEEP MATTERS. A pair that is coplanar only at the bind pose still
// ships — the parts pass through each other every animation cycle — but the
// converse also happens: an arm can swing flush against a torso and fight only
// mid-stride. So every rig is checked at rest AND across its animator's range.
//
// WHAT IT CANNOT SEE, and it is worth knowing before trusting a clean run: this
// finds surfaces that are coincident, not surfaces that INTERSECT. Two solids
// occupying the same voxel layer and sweeping through each other as a joint
// turns — which is what Gain's hair and his hood collar were doing on top of
// the coplanarity — produce a hard moving diagonal that looks exactly like a
// depth fight and is not one. Getting a rig to zero here is necessary and not
// sufficient; look at it.
//
// Usage:  bun tools/test-zfight.mjs [--verbose]
import * as THREE from 'three';
import { buildHeroRig } from '../src/player/hero-rig.ts';
import { HeroAnimator } from '../src/player/animations.ts';
import { ALL_SPECIES } from '../src/beasts/registry.ts';
import { BEAST_CYCLE_SLOTS } from '../src/core/types.ts';
// NPC_BODIES and not a character roster: since issue #60 a person's identity,
// placement and dialogue are content and there is no content runtime in this
// process — but a BODY is code, it is what this tool looks at, and the record is
// still the one place a body is named. See the note on it in src/world/npc.ts.
import { NPC_BODIES } from '../src/world/npc.ts';

// A 2D canvas, and nothing else, is the whole of the DOM a rig builder touches:
// the glow billboards and the flyers' contact shadows bake a radial ramp into a
// CanvasTexture the first time one is built. None of it matters to geometry —
// the texels are never read here — so the shim answers the calls and drops the
// pixels. It is installed in the module BODY, which runs after every import has
// been evaluated and before the first `buildRig()` below; a builder that starts
// wanting the DOM at module load will fail loudly here rather than be quietly
// stubbed, which is the right way round.
globalThis.document ??= {
  createElement: (tag) => {
    if (tag !== 'canvas') throw new Error(`test-zfight: no DOM here (createElement ${tag})`);
    return {
      width: 0, height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect() {}, clearRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
        measureText: () => ({ width: 0 }),
      }),
    };
  },
};

const VERBOSE = process.argv.includes('--verbose');

/**
 * How close two parallel faces have to be before the depth buffer can no longer
 * separate them, in world units.
 *
 * 4 mm, i.e. 4% of a 10 cm hero/NPC voxel. The number that actually matters is
 * zero — a coincident pair is authored, not tolerated — and everything found so
 * far has been at exactly 0.000. The margin is here so that a part which merely
 * grazes another is reported before a driver, a resolution or a camera distance
 * turns it into a seam on somebody's machine rather than on ours.
 */
const GAP = 0.004;
/**
 * Smallest overlap worth a word, in square world units.
 *
 * 2e-4 is 2 cm^2: a fifth of one 10 cm voxel face. Below that the pair is two
 * quads clipping corners, which no camera resolves into a seam; the patches
 * this tool was written for are 100x that.
 */
const MIN_AREA = 2e-4;
/** Same-facing test. cos(2.6 deg) — a pair this parallel is one surface. */
const PARALLEL = 0.999;
/**
 * How different two fighting faces have to look before the fight is a BUG,
 * as a distance between their baked vertex colours (each channel 0..1).
 *
 * This is the difference between an artifact and a curiosity, and it is why
 * this tool reports two numbers instead of one. Coincident faces are all over
 * this project — a beast's head is a separate model pushed into the front of
 * its body, and the two meet on a shared grid constantly — but the faces that
 * meet there are almost always the SAME colour, same normal and same shade, so
 * they resolve to identical pixels and the depth buffer's coin flip is
 * invisible. Gain's hood against Gain's hair is cream on indigo, and the coin
 * flip lands as a hard diagonal seam swimming across the back of his head.
 *
 * 0.05 in that space is about a value step in the palettes these builders use
 * — ROBE vs ROBE_D is 0.10, HAIR vs MANTLE is 0.44, and the flush pairs the
 * roster is full of are all 0.000.
 */
const CONTRAST = 0.05;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The quads of one baked voxel mesh, in the mesh's OWN space.
 *
 * `VoxelModel.build` emits exactly four consecutive vertices per face and
 * indexes them as two triangles, so stepping the position attribute in fours
 * recovers the quads without touching the index buffer. Read once per mesh and
 * re-transformed per pose — the pose sweep is the inner loop.
 */
function localQuads(mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  if (!pos || !nor || pos.count % 4 !== 0) return [];
  // ...and prove it IS one, rather than assuming. A flyer's contact shadow is a
  // PlaneGeometry — four vertices, and read as a ring they cross into a bow
  // tie, which would hand the clipper a nonsense polygon. The index pattern
  // `build()` writes is the signature, so check it on the first face and walk
  // away from any geometry that was made some other way.
  const idx = g.getIndex();
  if (!idx || idx.count !== (pos.count / 4) * 6) return [];
  if (idx.getX(0) !== 0 || idx.getX(1) !== 1 || idx.getX(2) !== 2
    || idx.getX(3) !== 0 || idx.getX(4) !== 2 || idx.getX(5) !== 3) return [];
  // A surface that does not write depth cannot fight for it.
  const mat = mesh.material;
  if (mat && (mat.depthWrite === false || mat.transparent === true)) return [];
  const col = g.getAttribute('color');
  const out = [];
  for (let i = 0; i < pos.count; i += 4) {
    const c = [];
    for (let k = 0; k < 4; k++) c.push(new THREE.Vector3().fromBufferAttribute(pos, i + k));
    out.push({
      c,
      n: new THREE.Vector3().fromBufferAttribute(nor, i),
      col: col ? new THREE.Vector3().fromBufferAttribute(col, i) : new THREE.Vector3(),
    });
  }
  return out;
}

/** Every mesh under a rig root, labelled by the named part it hangs from. */
function collectParts(root, named) {
  const label = new Map();
  for (const [name, obj] of Object.entries(named ?? {})) if (obj) label.set(obj, name);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    let name = 'root';
    for (let p = o; p; p = p.parent) {
      if (label.has(p)) { name = label.get(p); break; }
    }
    const quads = localQuads(o);
    if (!quads.length) return;
    // The occlusion ray leaves a body through the INSIDE of its outer shell,
    // which a front-side-only raycast does not see. Nothing here renders, so
    // widening the material is free and is the difference between "buried" and
    // "the ray sailed straight out of him".
    if (o.material) o.material.side = THREE.DoubleSide;
    parts.push({ name, mesh: o, quads });
  });
  return parts;
}

const _nm = new THREE.Matrix3();

/** Re-express one part's quads in world space at the pose the rig is in now. */
function worldFaces(part) {
  part.mesh.updateWorldMatrix(true, false);
  const m = part.mesh.matrixWorld;
  _nm.getNormalMatrix(m);
  const faces = [];
  for (const q of part.quads) {
    const c = q.c.map((v) => v.clone().applyMatrix4(m));
    const n = q.n.clone().applyMatrix3(_nm).normalize();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    faces.push({ c, n, col: q.col, d: n.dot(c[0]), minX, minY, minZ, maxX, maxY, maxZ });
  }
  return faces;
}

/** Sutherland-Hodgman: the intersection of two convex polygons in 2D. */
function clipPoly(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const side = (p) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
    const next = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
  }
  return out;
}

function polyArea(poly) {
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a2) * 0.5;
}

const _u = new THREE.Vector3(), _v = new THREE.Vector3();

/** Project a face's corners onto its own plane's tangent axes. */
function flatten(face, u, v) {
  return face.c.map((p) => [p.dot(u), p.dot(v)]);
}

// ---------------------------------------------------------------------------
// Is the fight on the OUTSIDE?
// ---------------------------------------------------------------------------

/**
 * What fraction of a coincident patch the player can actually see.
 *
 * This is the test that separates a bug from a curiosity, and without it this
 * tool condemns every rig in the game. Bodies here are assembled by SHOVING
 * models into one another — a head is pushed into a torso until the neck
 * disappears, a tail segment into the segment before it — so the two shells
 * cross, and where they cross there are coincident faces by the dozen. Almost
 * all of them are INSIDE the union of the two solids, where no camera will ever
 * be, and the depth buffer's coin flip between them is a fact about a place
 * nobody can look at.
 *
 * So: take points inside the overlap, step off the surface along its normal,
 * and cast a ray outward through the whole rig. A patch buried in a torso hits
 * the torso's outer shell on the way out and does not count. A patch on the
 * silhouette — Gain's hood against Gain's hair — hits nothing, and is a seam
 * the player is looking straight at.
 *
 * Sampling rather than solving: an exact answer means clipping the patch
 * against every other face's shadow, and the question being asked is only ever
 * "is any of this exposed", to which 13 stratified points is a firm answer at a
 * thousandth of the code.
 */
const _ray = new THREE.Raycaster();
_ray.far = 6;
const _o = new THREE.Vector3();

function exposedFraction(poly, u, v, n, d, meshes) {
  // Centroid, then each vertex pulled 55% of the way in, then the edge
  // midpoints likewise: interior points that still reach into the corners of a
  // patch whose middle happens to be covered.
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p[0]; cy += p[1]; }
  cx /= poly.length; cy /= poly.length;
  const samples = [[cx, cy]];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    for (const s of [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]]) {
      samples.push([cx + (s[0] - cx) * 0.55, cy + (s[1] - cy) * 0.55]);
    }
  }
  let open = 0;
  for (const [sx, sy] of samples) {
    // Rebuild the 3D point on the plane, then lift it clear of BOTH fighting
    // faces — they are within GAP of each other by definition.
    _o.copy(u).multiplyScalar(sx).addScaledVector(v, sy).addScaledVector(n, d + GAP * 2);
    _ray.set(_o, n);
    if (_ray.intersectObjects(meshes, false).length === 0) open++;
  }
  return open / samples.length;
}

/**
 * Every coincident overlap between two parts at the current pose.
 *
 * Broad phase first: parts whose world boxes miss each other cannot fight, and
 * within a pair that does, only the faces inside the shared box are candidates.
 * That is what keeps an O(n^2) face test cheap enough to run over a dozen rigs
 * at a hundred poses each — the shared box of a head and a torso is a collar,
 * not a body.
 */
function overlaps(a, b, hits) {
  const box = {
    minX: Math.max(a.box.minX, b.box.minX) - GAP, maxX: Math.min(a.box.maxX, b.box.maxX) + GAP,
    minY: Math.max(a.box.minY, b.box.minY) - GAP, maxY: Math.min(a.box.maxY, b.box.maxY) + GAP,
    minZ: Math.max(a.box.minZ, b.box.minZ) - GAP, maxZ: Math.min(a.box.maxZ, b.box.maxZ) + GAP,
  };
  if (box.minX > box.maxX || box.minY > box.maxY || box.minZ > box.maxZ) return;
  const inBox = (f) => f.maxX >= box.minX && f.minX <= box.maxX
    && f.maxY >= box.minY && f.minY <= box.maxY
    && f.maxZ >= box.minZ && f.minZ <= box.maxZ;
  const fa = a.faces.filter(inBox);
  if (!fa.length) return;
  const fb = b.faces.filter(inBox);
  for (const x of fa) {
    for (const y of fb) {
      if (x.n.dot(y.n) < PARALLEL) continue;
      if (Math.abs(x.d - y.d) > GAP) continue;
      if (x.maxX + GAP < y.minX || y.maxX + GAP < x.minX) continue;
      if (x.maxY + GAP < y.minY || y.maxY + GAP < x.minY) continue;
      if (x.maxZ + GAP < y.minZ || y.maxZ + GAP < x.minZ) continue;
      // Tangent frame on the shared plane: any axis not parallel to the normal.
      _u.set(1, 0, 0);
      if (Math.abs(x.n.x) > 0.9) _u.set(0, 1, 0);
      _u.crossVectors(_u, x.n).normalize();
      _v.crossVectors(x.n, _u);
      const poly = clipPoly(flatten(x, _u, _v), flatten(y, _u, _v));
      if (poly.length < 3) continue;
      const area = polyArea(poly);
      if (area < MIN_AREA) continue;
      hits.push({
        a: a.name, b: b.name, area, gap: Math.abs(x.d - y.d),
        // Same colour, same normal, same plane: the two faces resolve to the
        // SAME pixels, and whichever wins the depth test the player sees no
        // seam. See CONTRAST.
        contrast: x.col.distanceTo(y.col),
        at: x.c[0],
        // Which way the patch faces, i.e. where to put a camera to see it.
        facing: x.n.clone(),
        // The two quads' own extents, so a report names the two BOXES that
        // collided rather than one corner they happen to share.
        boxA: [x.minX, x.minY, x.minZ, x.maxX, x.maxY, x.maxZ],
        boxB: [y.minX, y.minY, y.minZ, y.maxX, y.maxY, y.maxZ],
        order: `${a.name}|${b.name}`,
        // Kept so exposure can be measured LATER, and only for the pair-worst
        // hit — a raycast per candidate would dominate the run.
        poly, u: _u.clone(), v: _v.clone(), n: x.n, d: x.d,
      });
    }
  }
}

/** Check the rig exactly as it stands, and fold the result into `acc`. */
function checkPose(parts, acc) {
  const live = parts.map((p) => {
    const faces = worldFaces(p);
    const box = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    };
    for (const f of faces) {
      if (f.minX < box.minX) box.minX = f.minX; if (f.maxX > box.maxX) box.maxX = f.maxX;
      if (f.minY < box.minY) box.minY = f.minY; if (f.maxY > box.maxY) box.maxY = f.maxY;
      if (f.minZ < box.minZ) box.minZ = f.minZ; if (f.maxZ > box.maxZ) box.maxZ = f.maxZ;
    }
    return { name: p.name, faces, box };
  });
  const hits = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      // Two batches of the SAME VoxelModel (a mesh and its emissive child) never
      // share a face: `build` culls against every cell regardless of batch. Skip
      // the pair anyway so a glowing eye can never be reported against the skull
      // it was cut out of.
      if (live[i].name === live[j].name && (parts[i].mesh.parent === parts[j].mesh
        || parts[j].mesh.parent === parts[i].mesh)) continue;
      overlaps(live[i], live[j], hits);
    }
  }
  // Biggest patch first, so a pair's exposure is measured a handful of times
  // per pose rather than once per candidate: the exposed area can never exceed
  // the raw one, so the moment a candidate's raw area falls below what this
  // pair has already been SEEN to show, nothing later in the list can win.
  hits.sort((p, q) => q.area - p.area);
  const meshes = parts.map((p) => p.mesh);
  for (const h of hits) {
    const key = h.a < h.b ? `${h.a} / ${h.b}` : `${h.b} / ${h.a}`;
    const cur = acc.get(key);
    if (cur && h.area <= cur.area) continue;
    const exposure = exposedFraction(h.poly, h.u, h.v, h.n, h.d, meshes);
    const seen = h.area * exposure;
    if (cur && seen <= cur.area) continue;
    acc.set(key, {
      pair: key, area: seen, buriedArea: h.area, exposure, gap: h.gap, contrast: h.contrast,
      at: [+h.at.x.toFixed(3), +h.at.y.toFixed(3), +h.at.z.toFixed(3)],
      facing: [+h.facing.x.toFixed(2), +h.facing.y.toFixed(2), +h.facing.z.toFixed(2)],
      order: h.order,
      boxA: h.boxA.map((n) => +n.toFixed(3)), boxB: h.boxB.map((n) => +n.toFixed(3)),
    });
  }
}

// ---------------------------------------------------------------------------
// The roster, and how each rig is posed
// ---------------------------------------------------------------------------

/** Times through one pose sweep. Coarse: this is looking for surfaces, not frames. */
const SAMPLES = 14;
const DT = 1 / 30;

function checkRig(name, root, named, poseAt) {
  const parts = collectParts(root, named);
  const acc = new Map();
  checkPose(parts, acc);              // bind pose — where authoring mistakes live
  for (let i = 0; i < SAMPLES; i++) {
    poseAt?.(i * (4.9 / SAMPLES), i);
    checkPose(parts, acc);
  }
  const all = [...acc.values()]
    .map((v) => ({
      pair: v.pair,
      area: +v.area.toFixed(5), buriedArea: +v.buriedArea.toFixed(5),
      exposure: +v.exposure.toFixed(2), gap: +v.gap.toFixed(4),
      contrast: +v.contrast.toFixed(3), at: v.at, facing: v.facing,
      order: v.order, boxA: v.boxA, boxB: v.boxB,
    }))
    .sort((x, y) => y.area - x.area);
  // A SEAM is the whole conjunction: coincident, exposed to the camera, and a
  // different colour on each side. Anything short of all three is a coincidence
  // the player cannot see.
  const seams = all.filter((p) => p.area >= MIN_AREA && p.contrast >= CONTRAST);
  return {
    rig: name,
    parts: parts.length,
    faces: parts.reduce((n, p) => n + p.quads.length, 0),
    seams: seams.length,
    worstSeamArea: seams.length ? seams[0].area : 0,
    // Coincident, but buried inside the body or the same colour on both sides.
    // Reported so a rig that grows one is visible in a diff, never asserted on.
    hiddenPairs: all.length - seams.length,
    pairs: VERBOSE ? all : seams.slice(0, 6),
  };
}

const results = [];

// -- hero -------------------------------------------------------------------
{
  const rig = buildHeroRig();
  const anim = new HeroAnimator();
  const attack = { active: false, combo: 0, t: 0, dur: 0.42 };
  const base = {
    time: 0, dt: DT, moveNorm: 0, sprinting: false, onGround: true, swimming: false,
    climbing: false, climbRate: 0, riding: false, velY: 0, attack,
    dead: false, deadT: 0, landBump: 0, hurtT: 0,
  };
  // Idle, running, sprinting, swimming, climbing, riding and mid-swing: the
  // states that move the arms across the torso, which is where a hero rig would
  // ever bring two parts flush.
  const MODES = [
    {}, { moveNorm: 1 }, { moveNorm: 1, sprinting: true },
    { swimming: true, moveNorm: 0.7, onGround: false },
    { climbing: true, climbRate: 1, onGround: false },
    { riding: true, moveNorm: 0.6 },
    { attack: { active: true, combo: 1, t: 0.2, dur: 0.42 } },
  ];
  const named = { ...rig };
  delete named.root;
  const acc = [];
  for (const mode of MODES) {
    const r = checkRig('hero', rig.root, named, (t) => {
      anim.update(rig, { ...base, ...mode, time: t });
    });
    acc.push(r);
  }
  const merged = acc.reduce((best, r) => (r.worstSeamArea > best.worstSeamArea ? r : best), acc[0]);
  results.push({ ...merged, rig: 'hero' });
}

// -- beasts -----------------------------------------------------------------
for (const sp of ALL_SPECIES) {
  const rig = sp.buildRig();
  const phases = new Array(BEAST_CYCLE_SLOTS).fill(0);
  const ctx = {
    action: 'idle', actionTime: 0, time: 0, moveSpeed: 0, dt: DT,
    cycle(slot, freq) { phases[slot] += freq * DT; return phases[slot]; },
  };
  const ACTIONS = ['idle', sp.locomotion === 'fly' ? 'fly' : sp.locomotion === 'swim' ? 'swim' : 'walk',
    'run', 'attack', 'cast', 'special', 'hurt', 'happy'];
  let worst = null;
  for (const action of ACTIONS) {
    const r = checkRig(sp.id, rig.root, rig.parts, (t, i) => {
      ctx.action = action;
      ctx.actionTime = i * DT * 4;
      ctx.time = t;
      ctx.moveSpeed = action === 'run' ? 1 : action === 'idle' ? 0 : 0.6;
      sp.animate(rig, ctx);
    });
    if (!worst || r.worstSeamArea > worst.worstSeamArea) worst = r;
  }
  results.push(worst);
}

// -- npcs -------------------------------------------------------------------
for (const [id, body] of Object.entries(NPC_BODIES)) {
  const rig = body.build();
  const ctx = { time: 0, dt: DT, attended: false };
  let worst = null;
  for (const attended of [false, true]) {
    const r = checkRig(id, rig.root, rig.parts, (t) => {
      ctx.time = t; ctx.attended = attended;
      body.animate(rig, ctx);
    });
    if (!worst || r.worstSeamArea > worst.worstSeamArea) worst = r;
  }
  results.push(worst);
}

// ---------------------------------------------------------------------------

/**
 * WHAT EACH RIG IS ALLOWED TO HAVE — measured, not chosen, and the target for
 * every line of it is 0.
 *
 * A guard that fails on everything is a guard nobody runs, and when this tool
 * was first pointed at the roster it failed on all twelve rigs: assembling a
 * body by shoving one voxel model into another puts two shells on a shared
 * grid, and the roster has been built that way since the first fox. So the
 * numbers below are a DEBT REGISTER, not approval. They are what each rig
 * measured on 2026-08-01, and the run fails the moment one of them goes up —
 * which is the assertion that actually matters, because it is the one that
 * stops a new model, or a new joint on an old one, from adding to the pile.
 *
 * Gain is the one at zero, and the one to read for how to get there: part the
 * grids at the joint where you can (`NECK_Z` in world/npc-gain.ts) and move the
 * paint where you cannot. Bring one down and lower its number in the same
 * commit; the aim is a file of zeroes.
 *
 * `worstSeamArea` is what to triage by — a 0.01 patch is a whole voxel face of
 * two colours flickering against each other, which is what the report that
 * prompted this tool was looking at.
 */
const BUDGET = {
  hero: 2,        // worst 0.00343 m2
  emberfox: 8,    // worst 0.00775
  aquaxol: 1,     // worst 0.00909
  sproutle: 3,    // worst 0.00836
  sparkit: 4,     // worst 0.01089
  frostwing: 4,   // worst 0.00750
  boulderpup: 1,  // worst 0.00798
  galebird: 5,    // worst 0.00886
  umbrakit: 4,    // worst 0.00593
  lumimoth: 3,    // worst 0.00757
  drakelet: 2,    // worst 0.01022
  gain: 0,        // clean, and the only one
};

const over = results
  .filter((r) => r.seams > (BUDGET[r.rig] ?? 0))
  .map((r) => ({ rig: r.rig, seams: r.seams, budget: BUDGET[r.rig] ?? 0 }));
// A rig missing from the table is a rig this tool has never seen — a new
// species, or one renamed. Budget 0, so it has to be looked at.
const unbudgeted = results.filter((r) => !(r.rig in BUDGET)).map((r) => r.rig);

console.log(JSON.stringify({
  gapThreshold: GAP,
  minAreaM2: MIN_AREA,
  contrastThreshold: CONTRAST,
  rigs: results.length,
  totalSeams: results.reduce((n, r) => n + r.seams, 0),
  hiddenPairs: results.reduce((n, r) => n + r.hiddenPairs, 0),
  cleanRigs: results.filter((r) => r.seams === 0).map((r) => r.rig),
  overBudget: over,
  unbudgeted,
  pass: over.length === 0,
  results,
}, null, 2));
if (over.length) process.exitCode = 1;
