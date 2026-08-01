/**
 * Terrain chunk mesher. Emits only exposed faces of the column heightfield:
 * one top quad per column plus side quads down to each lower neighbor.
 * Per-voxel hue jitter, directional face shading and true per-VERTEX corner
 * ambient occlusion baked into vertex colors.
 */
import * as THREE from 'three';
import { hashCell } from './noise';
import { CHUNK_SIZE, STONE, STONE_WARM, Terrain, WATER_LEVEL, makeScratch } from './terrain';

const S_TOP = 1.0;

/**
 * Baked side-face shade, indexed by the mesher's `dir` (0:+X, 1:-X, 2:+Z, 3:-Z).
 *
 * These used to be a single value per axis (0.86 for X, 0.78 for Z) — a baked
 * fake sun. The scene has a REAL directional sun, so that baked term stacked with
 * N.L and double-darkened exactly the faces that were already worst off: the sun
 * sits at (170,160,113), so a -X or -Z face receives no direct light at all, and
 * multiplying its ambient-only value by another 0.78 dropped a sunlit beach's
 * north wall to near-black. That is the "solid near-black flat quadrilateral"
 * finding — not a decal or a stray shadow quad, just a terrain step wall with
 * nothing left in it.
 *
 * So the baked shade is now the INVERSE of the sun's azimuth: the faces the sun
 * reaches carry the darkening (they have plenty of light to spare), and the faces
 * it never reaches carry none. Cube faces still read at three distinct values, but
 * the darkest face in the world gains about 28% and stops being a hole.
 * Derived from normalize(170, 113) = (0.832, 0.554): shade = 0.78 + 0.22 * (1 -
 * max(0, dot(n, sunXZ))). Re-derive if SUN_OFFSET in core/engine.ts moves.
 *
 * ROUND 2: the whole set drops by roughly a third, [0.82, 1.22, 0.90, 1.18] ->
 * [0.60, 0.97, 0.70, 0.95]. The SHAPE above is kept — the anti-sun faces still
 * carry the least baked darkening, so nothing goes back to being a hole — but the
 * TOP now wins by a wide margin, which it did not before.
 *
 * Worked through the actual rig rather than eyeballed. Sun 2.45 at 0xffebbe from
 * (170,160,113), hemi 0.86 (sky 0xc2dcf9 / ground 0x8fa4bd), bounce 0.42 at
 * 0xd7cfa6 from (-160,-62,-106). Green-channel irradiance per face:
 *
 *     top 1.872   +X 1.803   +Z 1.355   -X 0.675   -Z 0.605
 *
 * The sun sits at only 38 degrees of elevation, so a SUNWARD VERTICAL FACE
 * receives MORE direct light than the ground does (N.L 0.655 against 0.617). With
 * the old bake the rendered grass came out top 187 / +X 171 in sRGB code value —
 * a 1.09:1 ratio — and the silhouette survey photographed the consequence: "a
 * single grass cliff face ~800px wide is one flat saturated green, essentially the
 * same luminance as the top surface capping it... landforms have no readable form,
 * only outline". The colour survey measured the same two faces and reached the
 * opposite prescription — make the sunward face BRIGHTER, since physically it is.
 * That is physically right and pictorially wrong: a voxel world has no texture, so
 * the per-face value ramp IS the form shading, and Cube World's is unambiguously
 * top-bright.
 *
 * The new numbers were solved backwards through ACES at exposure 1.02 for a target
 * of top 187 / +X 150 / +Z 140 / -X 115 / -Z 108 on lit grass — a 1.25:1 top-to-
 * sunward-side ratio in code value (1.6:1 in linear radiance) where it was 1.09:1.
 * Nothing here touches a face's SHADOWED value: the two anti-sun faces get no sun
 * to lose and the bounce fill casts no shadow, so a shadowed wall is unchanged.
 *
 * RE-DERIVED against the rig as it stands after the lighting pass that landed in
 * the same round (sun 3.05, hemi 0.55 at 0xb4d6fb, bounce 0.38, exposure 1.20).
 * Green-channel irradiance is now:
 *
 *     top 1.935   +X 1.950   +Z 1.393   -X 0.475   -Z 0.412
 *
 * — note the sunward face has now overtaken the top OUTRIGHT, because cutting the
 * hemisphere hurts the horizontal normal most. Without this bake the world would
 * be flatter after that pass than before it. Multiplied through, faces land at
 * 1.00 / 0.60 / 0.50 / 0.24 / 0.20 of the top in linear radiance, which measures
 * on a real frame (_tw2-g-scan2.png, a face-on sand bank at x=800) as top faces
 * at L=193-197 over side faces at L=142-158, and on grass tops L=141-167 over
 * wall L=92-110. Re-derive again if the light rig moves.
 */
const SIDE_SHADE = [0.60, 0.97, 0.70, 0.95];

/**
 * How much of a warm bounce tint each side direction gets, 0..1, same `dir`
 * index as SIDE_SHADE.
 *
 * The two anti-sun directions receive NO direct light at all — only the
 * HemisphereLight, which is authored cool (sky 0xb8daff over ground 0x8fa4bd).
 * A one-block sand terrace's north wall therefore rendered as a dark
 * desaturated blue-grey quadrilateral, and the critic photographed exactly that
 * and filed it as "a rectangular pit with flat untextured interior walls" that
 * "reads as a missing chunk". It is not a hole and it is not missing — it is a
 * step wall lit by nothing but a blue fill.
 *
 * Two baked terms fix it inside the terrain's own vertex colours, which is the
 * only lever this file has (the scene lights live in core/engine.ts):
 *
 *  - SIDE_SHADE above is far LIGHTER on those directions than a physical shade
 *    would be (0.97/0.95 against 0.60/0.70 on the sunward pair). It went past 1.0
 *    for a round, which was a baked skylight+bounce boost; round 2 pulled the
 *    whole set down to restore top-vs-side form, but kept the anti-sun faces
 *    within 3-5% of neutral so they remain the least-punished faces in the world.
 *  - this array adds warmth on the same faces. Physically the bounce arriving at
 *    a shaded wall has come off sunlit ground a metre away, so it is warm; and
 *    perceptually a shaded face that keeps a hue reads as shade, while one that
 *    goes neutral-blue reads as a hole. Which is the whole complaint.
 */
const SIDE_BOUNCE = [0, 1, 0.4, 0.9];

/**
 * Corner-AO darkening per occlusion level (3 = fully open, 0 = boxed in).
 *
 * This is the single biggest contributor to the Cube World read: every exposed
 * face gets a per-vertex gradient from the solid cubes crowding its corners, so
 * a grass step is no longer a flat slab — its uphill edge sits in shade and its
 * downhill edge catches light. The ramp is steep — a 58% swing from open to fully
 * occluded — because voxel silhouettes have no texture to carry form; the crevice
 * darkening IS the texture.
 *
 * The floor is 0.42, not the 0.30 it started at. On a face the sun already misses
 * entirely, a 0.30 multiplier on top of ambient-only light leaves nothing at all,
 * and inside corners on shadowed walls were bottoming out to black. 0.42 keeps
 * every crevice clearly darker than its face while leaving something in it.
 */
const AO = [0.42, 0.60, 0.80, 1.0];

/** Classic voxel corner AO: two edge neighbours plus the diagonal. */
const aoLevel = (s1: boolean, s2: boolean, c: boolean): number =>
  s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));

/**
 * How submerged a face at world-y `y` is, 0 (dry) to 1 (a metre or more under).
 *
 * Everything below the surface gets its directional face shading and its corner
 * AO flattened toward 1.0 by this factor, because underwater light is scattered:
 * there is no crisp sun side and no black crevice down there. It is also the fix
 * for the ugliest thing in every lake — the bed's own terraces were rendering
 * with full side-face darkening and full contact AO, and even under 90% opaque
 * water those near-black bands showed through as rows of hard blue bricks
 * marching along the bottom, which read as broken geometry rather than as a lake
 * floor. Flattened, the bed becomes the smooth pale plane it should be and the
 * depth gradient in the water shader is what conveys the drop.
 */
const submerged = (y: number): number => {
  // The surface floats 0.28 above WATER_LEVEL (see SURFACE_Y in water.ts) and the
  // ramp is short: the shallowest flooded terrace is the one whose shading must
  // be flat, because it is the one the thinnest water sits over.
  // The ramp is SHORT — fully flat by 30cm down. It used to be 60cm, which left
  // the shallowest flooded terrace (top face 28cm under the surface, i.e. the one
  // that fills most of every bay) only half-flattened, and half of a hard dark
  // terrace edge is still a hard dark terrace edge once you are looking at it
  // through 90%-opaque water.
  const d = WATER_LEVEL + 0.28 - y;
  return d <= 0 ? 0 : d >= 0.3 ? 1 : d / 0.3;
};
/** Lerp a shading multiplier toward neutral by `t`. */
const flatten = (m: number, t: number): number => m + (1 - m) * t;

export function buildTerrainMesh(
  cx: number,
  cz: number,
  terrain: Terrain,
  material: THREE.Material,
): THREE.Mesh {
  const G = CHUNK_SIZE + 2;
  const n = G * G;
  const hA = new Float32Array(n);
  const hcA = new Float32Array(n);
  const topA = new Float32Array(n * 3);
  const dirtA = new Float32Array(n * 3);
  const warmA = new Float32Array(n);
  const grassA = new Float32Array(n);

  const sc = makeScratch();
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  for (let lz = -1; lz <= CHUNK_SIZE; lz++) {
    for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      terrain.columnInfo(ox + lx, oz + lz, sc);
      hA[i] = sc.h;
      hcA[i] = sc.hc;
      topA[i * 3] = sc.topR;
      topA[i * 3 + 1] = sc.topG;
      topA[i * 3 + 2] = sc.topB;
      dirtA[i * 3] = sc.dirtR;
      dirtA[i * 3 + 1] = sc.dirtG;
      dirtA[i * 3 + 2] = sc.dirtB;
      warmA[i] = sc.stoneWarm;
      grassA[i] = sc.grass;
    }
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const seed = terrain.seed;
  const gw2 = terrain.groundW;

  /**
   * Per-cube tonal jitter in [-1, 1], TRIANGULARLY distributed.
   *
   * A single `hashCell` is uniform, and that is what turned the meadow into a
   * tiled kitchen floor: a uniform distribution puts as many cubes at the
   * extremes as at the mean, so a flat plain was a mosaic of maximally-different
   * flat tones and the eye immediately read the cube grid as a pattern. Averaging
   * two independent hashes gives a triangular distribution — most cubes land
   * within a third of the amplitude, a few stand out — which is what a real
   * surface looks like: mostly even, with occasional individual blocks catching
   * the eye. Amplitude at the call sites is also down to roughly a third of what
   * it was, on the critic's advice; the baked corner AO carries the per-block
   * read now, and AO is a shape signal so it can never form a chequer.
   */
  const jitter = (x: number, y: number, z: number): number =>
    hashCell(seed, x, y, z) + hashCell(seed, x + 8191, y, z + 5077) - 1;

  /**
   * Emit one quad with per-vertex AO. `a0..a3` are AO multipliers for the four
   * corners in the order they are pushed.
   *
   * Two triangles cannot represent a bilinear gradient: whichever diagonal the
   * split runs along, the face centre takes the average of THAT diagonal's two
   * corners instead of all four, and the error shows as a hard crease straight
   * across the face. Flipping to the "better" diagonal (the usual trick) only
   * reduces it, and at the AO contrast this ramp uses it stayed clearly visible —
   * it was filed as "the mesh triangulation shows through as tonal creases", and
   * on a single-corner-occluded cube top it is exactly that.
   *
   * So: quads whose four corners agree (every interior plateau cube — the large
   * majority) stay two triangles, and only the ones with an actual gradient get
   * a centre vertex and a four-triangle fan. The centre carries the true
   * bilinear average, which makes the interpolation correct in every direction
   * and leaves no diagonal at all. The extra cost lands only on the step-adjacent
   * quads that need it.
   */
  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    qcx: number, qcy: number, qcz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
    a0: number, a1: number, a2: number, a3: number,
  ): void => {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, qcx, qcy, qcz, dx, dy, dz);
    nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    col.push(
      r * a0, g * a0, b * a0,
      r * a1, g * a1, b * a1,
      r * a2, g * a2, b * a2,
      r * a3, g * a3, b * a3,
    );
    if (a0 === a1 && a1 === a2 && a2 === a3) {
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      return;
    }
    const am = (a0 + a1 + a2 + a3) * 0.25;
    pos.push((ax + qcx) * 0.5, (ay + qcy) * 0.5, (az + qcz) * 0.5);
    nrm.push(nx, ny, nz);
    col.push(r * am, g * am, b * am);
    const m = base + 4;
    idx.push(
      base, base + 1, m,
      base + 1, base + 2, m,
      base + 2, base + 3, m,
      base + 3, base, m,
    );
  };

  // strata color for deep cliff cells (horizontal sedimentary bands)
  let str = 0;
  let stg = 0;
  let stb = 0;
  const strata = (y: number, warm: number): void => {
    const band = Math.floor(y / 3);
    const bm = 0.8 + hashCell(seed, band, 977, 0) * 0.32;
    str = (STONE.r + (STONE_WARM.r - STONE.r) * warm) * bm;
    stg = (STONE.g + (STONE_WARM.g - STONE.g) * warm) * bm;
    stb = (STONE.b + (STONE_WARM.b - STONE.b) * warm) * bm;
  };

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = (lz + 1) * G + (lx + 1);
      const i3 = i * 3;
      const H = hA[i];
      const wx = ox + lx;
      const wz = oz + lz;
      const hE = hA[i + 1];
      const hW = hA[i - 1];
      const hS = hA[i + G];
      const hN = hA[i - G];

      // ---- top face -------------------------------------------------------
      const steep = Math.max(
        Math.abs(H - hE), Math.abs(H - hW), Math.abs(H - hS), Math.abs(H - hN),
      );
      // Slope shading: steeper continuous gradient darkens up to 12%.
      const gx = (hcA[i + 1] - hcA[i - 1]) * 0.5;
      const gz = (hcA[i + G] - hcA[i - G]) * 0.5;
      const slope = Math.sqrt(gx * gx + gz * gz);
      const slopeDark = 1 - Math.min(slope * 0.06, 0.12);
      // Per-cube value jitter. Triangular (see `jitter`) and at ±5% for grass,
      // ±3.5% for sand and snow — roughly a third of the ±15% this carried in the
      // build the critic photographed as a chessboard. A pale desaturated surface
      // gets the smaller share: saturated grass has a hue for the jitter to ride
      // on, so it reads as material, while on sand there is nothing but value and
      // the cube grid resolves as a chequer at a much lower amplitude.
      const jt = jitter(wx, H, wz);
      // An independent hue wobble on the r/b axis, so neighbouring cubes differ a
      // little in warmth as well as value. Warmth differences are far safer than
      // value differences — the eye pools them into "material" rather than
      // resolving them as a grid — so this one keeps most of its amplitude.
      // Grass now gets nearly double what sand does (±8.5% vs ±4%), for the reason
      // in `mt` below.
      const gw = grassA[i];
      // Sand's warmth wobble goes UP (±6% -> ±7.5%) as its value jitter comes
      // down: warmth is where a pale surface has headroom, because ochre-vs-bone
      // neighbours read as mineral grains where light-vs-dark neighbours read as
      // tiles.
      const hw = jitter(wx, H + 31, wz) * (0.075 + gw * 0.045);
      // Landform-scale value wash from the lattice-free wave field, ~22 units.
      // Broad and gentle: its job is to stop a big level plain being one number,
      // not to be seen.
      // ±5% -> ±7% in round 2. Every point of amplitude moved out of the per-cube
      // jitter below has to land somewhere, and this field is the safe place for
      // it: WaveField has no lattice (see noise.ts) and a 22-unit period cannot
      // interact with a 1-unit grid, so it can carry value without ever forming a
      // chequer. Landform-scale value variation was also exactly what the colour
      // survey asked for — "the left hillside covers roughly 15% of the frame and
      // 80% of its pixels sit inside a 19-value luminance band".
      const drift = gw2.sample(wx, wz) * 0.07;
      // ±10% for grass, ±4.2% for sand/snow, up from ±4.8%/±3.5%.
      //
      // Measured, not guessed: at ±4.8% in LINEAR radiance, the sRGB code-value
      // difference between two neighbouring grass cubes is 4.8% / 2.4 ≈ 2%, i.e.
      // about four levels out of 255 — and because `jitter` is triangular, the
      // TYPICAL pair differs by a third of that. _tw-b-ground.png (a 6-unit-high
      // shot straight down onto a meadow, where a cube is ~120 px across) shows
      // exactly what that predicts: one flat green sheet with no per-block read at
      // all, which is the single biggest gap against Cube World.
      //
      // ±10% survives the earlier chessboard finding because it does not arrive as
      // pure value: the saturation link below ties it to a hue shift, so a brighter
      // cube is also a bleached one and a darker cube a lusher one. The eye pools a
      // value+saturation pair as "different clump of grass" where it resolves a
      // pure value pair as "different tile". Sand keeps the small share it had —
      // there is no hue there for the jitter to ride on.
      // Sand's own share went the other way — UP from ±3.5% to ±4.2%, and its hue
      // wobble from ±4.5% to ±6% — because _tw-b-bay.png shows a sand basin forty
      // cubes across at one value. The chequer risk that kept it low is real, but
      // it comes from VALUE, and warmth is where sand's headroom is: a beach is
      // mineral grains of different colours, so ochre-vs-bone neighbours read as
      // grains where light-vs-dark neighbours read as tiles.
      // ROUND 2: sand's per-cube VALUE share is cut again, 4.2% -> 2.6%, and
      // grass's is raised to keep its total where it was (10.0% -> 10.4%).
      //
      // This is the "kill the checkerboard on the sand biome" finding, and the
      // previous round's reasoning was half right: a forty-cube basin at one value
      // IS dead, but per-CUBE value is the wrong medicine for it, because on a
      // surface with no chroma the eye has nothing to pool the variation into and
      // resolves the grid instead — "a per-block two-tone chequer that reads as a
      // texture-atlas debug grid". The variation the basin was missing has moved
      // to terrain.ts as a ±8.5% DUNE-scale wash over thirty units, which is the
      // scale a beach actually undulates at and far too coarse to alias with the
      // cube grid. What is left here is the small grain-to-grain component.
      // GRASS's value share comes down too, 10.0% -> 6.6%, and its warmth wobble
      // goes up to ±12% to pay for it. _tw2-c-down.png is a nine-unit-high shot
      // straight onto the meadow, where a cube is ~55 px: at ±10% the sward was an
      // unmistakable chequerboard of light and dark green squares — the exact
      // artefact this file's history keeps rediscovering, arrived at from the
      // other side after the previous round pushed the amplitude up to fight
      // flatness. Warmth carries it instead. In the same capture the SAND is now
      // the well-behaved surface, which is the dune-scale wash in terrain.ts
      // doing the work per-cube value used to be asked to do.
      const mt = (1 + drift + jt * (0.026 + gw * 0.032)) * slopeDark * S_TOP;

      // Second material read, from the shape of the ground rather than noise.
      // The discrete Laplacian of the CONTINUOUS height is a free curvature
      // signal (the border ring is already meshed): positive = the column sits
      // in a hollow, negative = it crowns a ridge. Cube World's meadows get
      // their depth from exactly this — damp shaded moss collecting in dips,
      // sun-bleached yellow-green on the swells — and noise alone can never
      // fake it because it doesn't know where the landforms are.
      const lap = (hcA[i + 1] + hcA[i - 1] + hcA[i + G] + hcA[i - G]) * 0.25 - hcA[i];
      const hollow = Math.min(Math.max(lap * 2.4, 0), 1) * gw;
      const crown = Math.min(Math.max(-lap * 2.4, 0), 1) * gw;

      let r = topA[i3];
      let g = topA[i3 + 1];
      let b = topA[i3 + 2];
      // Hollows: -14% value and pushed toward blue-green (deep moss).
      // Crowns: +9% value and pushed toward yellow (bleached, dusty).
      const hm = 1 - hollow * 0.14;
      r *= hm * (1 - hollow * 0.10);
      g *= hm;
      b *= hm * (1 + hollow * 0.16);
      const cm = 1 + crown * 0.09;
      r *= cm * (1 + crown * 0.13);
      g *= cm;
      b *= cm * (1 - crown * 0.14);

      // Dirt breaking through where the ground tips: gravel and bare earth show
      // on the flanks of every real hillside long before it becomes cliff.
      // Gated on `slope` (scale-free gradient) not on `steep` (which is 1 on
      // every single grass terrace, so it would smear dirt over the whole map).
      const dirtW = Math.min(Math.max((slope - 1.05) / 2.1, 0), 1) * 0.5 * gw;
      if (dirtW > 0) {
        r += (dirtA[i3] - r) * dirtW;
        g += (dirtA[i3 + 1] - g) * dirtW;
        b += (dirtA[i3 + 2] - b) * dirtW;
      }

      // Ground litter: a rare per-cube hash pick, so it scatters with no grid
      // and no tiling. Clover reads as a darker blue-green cube in the sward;
      // pebbles as a single grey cube.
      const sp = hashCell(seed, wx, H + 7, wz);
      if (gw > 0.35) {
        if (sp > 0.94) {
          r *= 0.72; g *= 0.88; b *= 0.82; // clover: deeper, bluer green
        } else if (sp > 0.895) {
          r *= 1.18; g *= 1.05; b *= 0.84; // dry straw tuft
        } else if (sp > 0.855) {
          r *= 0.80; g *= 1.06; b *= 0.72; // deep lush blade clump
        } else if (sp < 0.020) {
          // A stone in the sward, MOSSY not pale. This used to lerp 45% toward
          // (0.30, 0.29, 0.29), a mid grey — and against saturated grass that is a
          // near-white square. _tw-b-ground.png has several of them scattered
          // across the meadow and they read as missing-texture artefacts rather
          // than as pebbles. A stone lying in grass is dark, damp and carries the
          // grass's own hue in its lichen; this one is a third the luminance.
          const pw = 0.55;
          r += (0.105 - r) * pw; g += (0.115 - g) * pw; b += (0.090 - b) * pw;
        }
      } else {
        // Sand, snow and lake bed used to get NO litter at all, and they are the
        // surfaces with the least going on: a beach filled a third of several
        // frames as one unbroken beige. Bright sand also sits near the top of the
        // tone curve, where the multiplicative jitter above loses most of its
        // punch, so these picks are additive-ish and pushed harder. Damp grains
        // and shell grit are what a real dune has instead of grass.
        // Picks widened from ~11% of cubes to ~19%, and the grit made both darker
        // and three times as common. On a surface with no hue to jitter, scattered
        // individual grains ARE the texture, and at the old rates a forty-cube
        // basin got two of them.
        if (sp > 0.945) {
          r *= 1.09; g *= 1.07; b *= 1.02; // sun-bleached grain
        } else if (sp < 0.110) {
          r *= 0.87; g *= 0.90; b *= 0.96; // damp / shaded grain, cooler
        } else if (sp > 0.905 && sp < 0.938) {
          const pw = 0.5; // shell grit / a dark pebble
          r += (0.20 - r) * pw; g += (0.19 - g) * pw; b += (0.17 - b) * pw;
        }
      }

      r *= mt * (1 + hw);
      g *= mt;
      b *= mt * (1 - hw);
      // Saturation link. The per-cube VALUE jitter above is doubled from what it
      // was, and a doubled pure-value jitter is exactly the chessboard this file's
      // history warns about. Tying saturation to it inversely is what buys the
      // amplitude back: a cube the hash made brighter is also pulled toward grey
      // (sun-bleached, dusty), a cube it made darker is pushed away from grey
      // (lush, damp). That is how a real sward varies, and the eye reads the pair
      // as two clumps of grass rather than as two tiles of one floor.
      //
      // Grass only. On sand and snow there is barely any chroma to move, and the
      // ±3% value jitter they keep does not need the cover.
      if (gw > 0) {
        // ASYMMETRIC. The link used to be `1 - jt * 0.30`, i.e. saturation ran
        // 0.70..1.30, and the 1.30 end is where the "sunlit grass tops read
        // rgb(0,112,3) — literally zero red" measurement came from: grass linear
        // red is around a sixth of its luminance, so pushing chroma out by 30%
        // subtracts more red than the albedo has and the clamp below eats the
        // rest. Once red is pinned at zero the surface cannot receive the sun's
        // warm key at all. Pulling toward grey is safe at full strength (it can
        // only ever move a channel toward the mean), so only the outward half is
        // halved — the visible variation is almost unchanged and no channel is
        // driven out of gamut.
        const sat = jt >= 0 ? 1 - jt * 0.28 * gw : 1 - jt * 0.20 * gw;
        const lum = (r + g + b) * 0.3333;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
        if (r < 0) r = 0;
        if (g < 0) g = 0;
        if (b < 0) b = 0;
      }
      if (steep >= 3) {
        // steep crowns read as bare stone
        const cliffW = Math.min((steep - 2) / 3, 1) * 0.85;
        strata(H, warmA[i]);
        r += (str * mt - r) * cliffW;
        g += (stg * mt - g) * cliffW;
        b += (stb * mt - b) * cliffW;
      }

      // Corner AO for the top face: the eight columns around this one, each
      // occluding when it rises above H (i.e. it has a cube in the layer that
      // sits directly on this top face).
      const oE = hE > H, oW = hW > H, oS = hS > H, oN = hN > H;
      const oSE = hA[i + 1 + G] > H, oSW = hA[i - 1 + G] > H;
      const oNE = hA[i + 1 - G] > H, oNW = hA[i - 1 - G] > H;
      const subT = submerged(H) * 0.94;
      quad(
        lx, H, lz, lx, H, lz + 1, lx + 1, H, lz + 1, lx + 1, H, lz,
        0, 1, 0, r, g, b,
        flatten(AO[aoLevel(oW, oN, oNW)], subT),
        flatten(AO[aoLevel(oW, oS, oSW)], subT),
        flatten(AO[aoLevel(oE, oS, oSE)], subT),
        flatten(AO[aoLevel(oE, oN, oNE)], subT),
      );

      // ---- side faces (down to each lower neighbor) -----------------------
      for (let dir = 0; dir < 4; dir++) {
        const nH = dir === 0 ? hE : dir === 1 ? hW : dir === 2 ? hS : hN;
        // Heights of the two columns flanking the neighbour column, in the
        // face's tangential order (tangent A first, matching the vertex order
        // v0=lowA, v1=highA, v2=highB, v3=lowB used by every branch below).
        let hTA: number;
        let hTB: number;
        if (dir === 0) { hTA = hA[i + 1 - G]; hTB = hA[i + 1 + G]; }
        else if (dir === 1) { hTA = hA[i - 1 + G]; hTB = hA[i - 1 - G]; }
        else if (dir === 2) { hTA = hA[i + G + 1]; hTB = hA[i + G - 1]; }
        else { hTA = hA[i - G - 1]; hTB = hA[i - G + 1]; }

        for (let y = nH + 1; y <= H; y++) {
          const depth = H - y;
          let br: number;
          let bg: number;
          let bb: number;
          if (depth <= 0) {
            br = topA[i3] * 0.96;
            bg = topA[i3 + 1] * 0.96;
            bb = topA[i3 + 2] * 0.96;
          } else if (depth <= 2) {
            br = dirtA[i3];
            bg = dirtA[i3 + 1];
            bb = dirtA[i3 + 2];
          } else {
            strata(y, warmA[i]);
            br = str;
            bg = stg;
            bb = stb;
          }
          // Same per-cube value + hue treatment as the top faces, and for the
          // same reason: a five-voxel cliff of one flat colour is a painted flat,
          // while a wall whose every cube differs a little in value and warmth
          // reads as stacked rock. Triangular and modest, like the tops — a wall
          // of maximally-different cubes reads as static, not as rock.
          const j = jitter(wx, y, wz);
          const jw = jitter(wx, y + 31, wz) * 0.05 + SIDE_BOUNCE[dir] * 0.055;
          // `y - 0.5` is the centre of this one-voxel-tall quad.
          const sub = submerged(y - 0.5);
          const shade = flatten(SIDE_SHADE[dir] * (1 + j * 0.09), sub * 0.9);
          br *= shade * (1 + jw);
          bg *= shade;
          bb *= shade * (1 - jw);
          const subA = sub * 0.88;
          // Corner AO in the plane of the face. The vertical neighbour for the
          // lower corners is the neighbour column itself, which is solid at
          // y-1 exactly on the bottom-most quad of a wall — so the classic
          // formula reproduces the old hand-rolled "contact" darkening for
          // free, and additionally shades the wall where a flanking column
          // rises beside it (inside corners of every step and gully).
          const upA = flatten(AO[aoLevel(hTA >= y, false, hTA >= y + 1)], subA);
          const upB = flatten(AO[aoLevel(hTB >= y, false, hTB >= y + 1)], subA);
          const loA = flatten(AO[aoLevel(hTA >= y, nH >= y - 1, hTA >= y - 1)], subA);
          const loB = flatten(AO[aoLevel(hTB >= y, nH >= y - 1, hTB >= y - 1)], subA);
          const y0 = y - 1;
          // Submerged walls get their SHADING NORMAL rotated up toward the sky.
          //
          // This is the fix for the single ugliest thing in the world, and three
          // separate water findings are all this one artefact: "a row of opaque
          // pale solid cubes stepping down like ice cubes with hard dark gaps",
          // "soft concentric arcs that read as map contour lines" and "no depth
          // gradient — the whole bay is one flat cyan". None of them are the water
          // shader. They are the LAKE BED: the mesher terraces the bed in 1-unit
          // steps, and a vertical wall receives a tiny fraction of the sun a
          // horizontal top does, so every terrace printed through 90%-opaque water
          // as a hard dark stripe following the bed contour. Flattening the baked
          // shade (which the `flatten` calls above already do) cannot help, because
          // the darkness comes from the REAL directional light and N.L.
          //
          // Turning the normal up makes a submerged wall take the same light as the
          // bed around it, so the terraces disappear and the bed becomes the smooth
          // pale plane it should be — leaving the water's own depth ramp as the only
          // thing conveying the drop-off, which is exactly what it is for. Above
          // water `sub` is 0 and nothing changes.
          const nb = 1 - sub;
          const ny = sub;
          // Normalise the blend so a half-submerged wall is not lit as if it had a
          // 1.4-long normal.
          const nl = 1 / Math.sqrt(nb * nb + ny * ny);
          const nh = nb * nl;
          const nv = ny * nl;
          if (dir === 0) {
            quad(
              lx + 1, y0, lz, lx + 1, y, lz, lx + 1, y, lz + 1, lx + 1, y0, lz + 1,
              nh, nv, 0, br, bg, bb, loA, upA, upB, loB,
            );
          } else if (dir === 1) {
            quad(
              lx, y0, lz + 1, lx, y, lz + 1, lx, y, lz, lx, y0, lz,
              -nh, nv, 0, br, bg, bb, loA, upA, upB, loB,
            );
          } else if (dir === 2) {
            quad(
              lx + 1, y0, lz + 1, lx + 1, y, lz + 1, lx, y, lz + 1, lx, y0, lz + 1,
              0, nv, nh, br, bg, bb, loA, upA, upB, loB,
            );
          } else {
            quad(
              lx, y0, lz, lx, y, lz, lx + 1, y, lz, lx + 1, y0, lz,
              0, nv, -nh, br, bg, bb, loA, upA, upB, loB,
            );
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  // Named for `__dbgSurfaceY` in main.ts, which raycasts a column and reports
  // what is drawn there — the answer is only useful if it can name the surface.
  mesh.name = `terrain:${ox},${oz}`;
  mesh.position.set(ox, 0, oz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
