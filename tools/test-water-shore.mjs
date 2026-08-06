// Guards issue #93: white surf stays on the water surface and never climbs the
// wet-sand apron, which is the first dry terrace above it.
//
// This test inspects the actual fragment program handed to WebGL. That is the
// narrowest deterministic boundary for the regression: the apron and water are
// one geometry and one ShaderMaterial, and `vLand` is the branch that decides
// which pixels may receive FOAM.
//
// Usage: bun tools/test-water-shore.mjs
// Exits non-zero.
import { createWaterMaterial } from '../src/world/water.ts';

const material = createWaterMaterial();
const shader = material.fragmentShader;
const landStart = shader.indexOf('if (vLand > 0.5)');
const landEnd = shader.indexOf('// Three ramps over four stops.', landStart);
const land = shader.slice(landStart, landEnd);
const water = shader.slice(landEnd);

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(landStart >= 0 && landEnd > landStart,
  'could not isolate the wet-sand apron branch');
check(!land.includes('FOAM'),
  'the elevated wet-sand apron still receives white foam');
check(land.includes('vec3(0.145, 0.115, 0.080)') && land.includes('damp * 0.70'),
  'the elevated terrace lost its dark wet-sand tint');
check(water.includes('col = mix(col, FOAM, surf)'),
  'the water-level surf line was removed with the elevated foam');

console.log(JSON.stringify({
  apronHasFoam: land.includes('FOAM'),
  apronHasWetSand: land.includes('damp * 0.70'),
  waterHasSurf: water.includes('col = mix(col, FOAM, surf)'),
  failures,
}, null, 2));

material.dispose();
if (failures.length) process.exit(1);
