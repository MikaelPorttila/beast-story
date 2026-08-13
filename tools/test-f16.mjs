// HALF-PRECISION GUARD — the fourth probe in tools/ that never opens a browser.
//
// The terrain mesh stores its normals and colours as `Float16Array`
// (world/chunk.ts), which halves the largest resident buffer set in the game.
// That narrowing is safe because of two properties of what the mesher emits,
// and NEITHER is enforced anywhere else:
//
//   * every normal component is exactly 0 or ±1, because the ground is cubes
//     and a cube face points down an axis. fp16 stores those three values
//     exactly, so a normal costs nothing at all to narrow.
//   * every colour sits low enough that the gap between adjacent fp16 values
//     is finer than one step of the 8-bit screen it lands on.
//
// The second is the one with a budget, and it is a property of MAGNITUDE rather
// than of range: fp16 spacing doubles with the exponent, so a colour near 1
// resolves to 1/1024 and a colour near 16 only to 1/64. Terrain colours are
// tinted and jittered rather than clamped — the sweep below measures them up to
// about 1.11, over the 0..1 a reader would assume — so the assertion is written
// against the spacing, not against a range nobody maintains.
//
// WHAT WOULD FAIL HERE. A shading pass that gives the ground a diagonal normal,
// or an emissive/HDR terrain colour that leaves the low exponents. Both are
// changes a screenshot would not obviously catch: the first quantises a normal
// by ~1e-4 and shifts the light slightly, and the second bands a gradient. Both
// are caught here in arithmetic, in about a second, with no browser and no GPU.
//
// WHAT IT CANNOT SEE. Whether the buffer actually UPLOADS as GL_HALF_FLOAT.
// Nothing renders in this process, and `chunk.ts` reaches three through an
// `as unknown as THREE.TypedArray` cast because @types/three's TypedArray union
// predates Float16Array — so the type system is not checking that seam either.
// A three upgrade that stopped handling Float16Array would pass this probe and
// break the game; that belongs to test-gfx, in a browser.
//
// Usage:  bun tools/test-f16.mjs [--verbose]
import * as THREE from "three";
import { Terrain } from "../src/world/terrain.ts";
import { buildTerrainMeshSteps } from "../src/world/chunk.ts";

const VERBOSE = process.argv.includes("--verbose");

/**
 * One step of the 8-bit screen the colour lands on. The fp16 gap has to be
 * finer than this or the narrowing is visible as banding.
 */
const DISPLAY_STEP = 1 / 255;

/**
 * The gap between adjacent fp16 values at `v` — 10 mantissa bits under the
 * value's own exponent. Computed from the STORED number because the f32 source
 * is gone by the time a geometry exists, and that is the honest thing to bound:
 * it is the worst error the narrowing could have introduced at this magnitude.
 */
const quantum = (v) => {
  const a = Math.abs(v);
  return a === 0 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(a)) - 10);
};

// Three seeds so the sweep is not one world's terrain, and four chunks apiece
// spread off the origin so it is not one biome's palette either.
const SEEDS = [1337, 7, 99991];
const CHUNKS = [
  [0, 0],
  [3, -2],
  [-5, 4],
  [11, 11],
];

const fail = [];
const mat = new THREE.MeshBasicMaterial();
let normalComponents = 0;
let colourComponents = 0;
let offAxis = 0;
const offAxisSample = [];
let colMin = Infinity;
let colMax = -Infinity;
let worstQuantum = 0;
let worstAt = null;

for (const seed of SEEDS) {
  const terrain = new Terrain(seed);
  for (const [cx, cz] of CHUNKS) {
    // The mesher is a generator so the streamer can budget it per row; nothing
    // here cares about the rows, only about the geometry at the end.
    const steps = buildTerrainMeshSteps(cx, cz, terrain, mat);
    let step = steps.next();
    while (!step.done) {
      step = steps.next();
    }
    const attrs = step.value.geometry.attributes;

    if (attrs.normal.array.constructor !== Float16Array) {
      fail.push(
        `seed ${seed} chunk ${cx},${cz}: normals are ${attrs.normal.array.constructor.name}, not Float16Array`,
      );
    }
    if (attrs.color.array.constructor !== Float16Array) {
      fail.push(
        `seed ${seed} chunk ${cx},${cz}: colours are ${attrs.color.array.constructor.name}, not Float16Array`,
      );
    }

    for (const v of attrs.normal.array) {
      normalComponents++;
      if (v !== 0 && v !== 1 && v !== -1) {
        offAxis++;
        if (offAxisSample.length < 8) {
          offAxisSample.push({ seed, chunk: [cx, cz], v });
        }
      }
    }
    for (const v of attrs.color.array) {
      colourComponents++;
      if (v < colMin) {
        colMin = v;
      }
      if (v > colMax) {
        colMax = v;
      }
      const q = quantum(v);
      if (q > worstQuantum) {
        worstQuantum = q;
        worstAt = { seed, chunk: [cx, cz], v };
      }
    }

    step.value.geometry.dispose();
  }
}

if (offAxis > 0) {
  fail.push(
    `${offAxis} of ${normalComponents} normal components are not exactly 0 or ±1 — ` +
      `the ground is no longer axis-aligned cubes, so narrowing normals to fp16 now costs accuracy: ` +
      JSON.stringify(offAxisSample),
  );
}
if (worstQuantum >= DISPLAY_STEP) {
  fail.push(
    `fp16 spacing at colour ${worstAt?.v} is ${worstQuantum}, at or past one display step ` +
      `${DISPLAY_STEP} — terrain colour has left the exponents fp16 resolves finely enough`,
  );
}

console.log(
  JSON.stringify(
    {
      seeds: SEEDS,
      chunksPerSeed: CHUNKS.length,
      normals: {
        components: normalComponents,
        offAxis,
        sample: VERBOSE ? offAxisSample : undefined,
      },
      colours: { components: colourComponents, min: colMin, max: colMax },
      worstQuantum,
      worstAt,
      displayStep: DISPLAY_STEP,
      // How much magnitude headroom is left before banding. Measured 4.0 the day
      // this landed; a change that drops it toward 1 is worth reading about.
      headroom: +(DISPLAY_STEP / worstQuantum).toFixed(2),
      failures: fail,
      pass: fail.length === 0,
    },
    null,
    2,
  ),
);

if (fail.length > 0) {
  console.error("FAIL\n  " + fail.join("\n  "));
  process.exit(1);
}
console.error("PASS");
