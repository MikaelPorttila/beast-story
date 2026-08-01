// The road guard: is the road you SEE the road you STAND ON?
//
// Every other probe in here compares the world against itself — the player
// against `getHeight`, a collider against a mesh's own footprint — and none of
// them can see the failure this one exists for: the hero exactly where the
// physics puts him, and buried to the chest, because the ribbon in front of him
// was drawn above his feet. `__dbgSurfaceY` raycasts the actual scene just over
// the walking surface and reports what is there, which is the only way to ask.
//
// TWO NUMBERS, and they fail for different reasons.
//
//   sink  — how far the drawn surface floats over the walking surface, sampled
//           along every carriageway. Anything past ~0.2 is visible on a figure
//           1.8 units tall. Before the ribbon was made to sample the surface it
//           was 1.66 at the spawn; it is 0.19 there now.
//   step  — the largest jump in the WALKING surface between neighbours a
//           quarter unit apart, on the carriageway. MAX_STEP_UP is 0.5, so
//           anything at or over that is a wall the hero cannot cross and cannot
//           see. This is a KNOWN, PRE-EXISTING failure at the fork: 0.801,
//           where three carriageways overlap and `surfaceAt` answers with the
//           nearest road's deck, which jumps between two values across the line
//           equidistant from them. See the note in AGENTS.md.
//
//   bun tools/test-road.mjs
import { launchBrowser, newPage, wait, logPageErrors } from './browser.mjs';

const browser = await launchBrowser();
const page = await newPage(browser, { width: 900, height: 600 });
logPageErrors(page);
await page.goto('http://localhost:5187/?fps=30&menu=0', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await wait(5000);   // the corridor has to be streamed before it can be hit

const out = await page.evaluate(() => {
  const towns = window.__dbgTowns();

  // -- what is drawn, against what is walked on ----------------------------
  const roads = towns.roads.map((r) => {
    const p = r.path;
    let worst = 0;
    let at = null;
    let over = 0;
    let tested = 0;
    for (let i = 1; i < p.length / 3; i++) {
      const ax = p[(i - 1) * 3], az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3], bz = p[i * 3 + 2];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const s = window.__dbgSurfaceY(x, z);
        // Only the ground surfaces answer this question; a bush overhead is not
        // something the hero is buried in. Both are named for exactly this.
        if (!s.hit || !/^(road:|terrain:)/.test(s.hit)) continue;
        tested++;
        if (s.sink > 0.2) over++;
        if (s.sink > worst) {
          worst = s.sink;
          at = { x: +x.toFixed(1), z: +z.toFixed(1), drawn: s.surface, walked: s.ground, by: s.hit };
        }
      }
    }
    return { id: r.id, tested, worstSink: +worst.toFixed(3), over20cm: over, at };
  });

  // -- steps in the walking surface, on the carriageway only ---------------
  const segs = [];
  for (const r of towns.roads) {
    const p = r.path;
    for (let i = 1; i < p.length / 3; i++) {
      segs.push([p[(i - 1) * 3], p[(i - 1) * 3 + 2], p[i * 3], p[i * 3 + 2]]);
    }
  }
  const onRoad = (x, z) => {
    for (const [ax, az, bx, bz] of segs) {
      const dx = bx - ax, dz = bz - az;
      const L = dx * dx + dz * dz || 1;
      let u = ((x - ax) * dx + (z - az) * dz) / L;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      if (Math.hypot(x - (ax + dx * u), z - (az + dz * u)) <= 2.6) return true;
    }
    return false;
  };
  const h = (x, z) => window.__dbgWorld(x, z).ground;
  const S = 0.25;
  let step = 0;
  let stepAt = null;
  // The fork, which is the only place carriageways overlap.
  for (let x = 87; x <= 123; x += S) {
    for (let z = -24; z <= 12; z += S) {
      if (!onRoad(x, z)) continue;
      const a = h(x, z);
      for (const [dx, dz] of [[S, 0], [0, S]]) {
        if (!onRoad(x + dx, z + dz)) continue;
        const d = Math.abs(h(x + dx, z + dz) - a);
        if (d > step) { step = d; stepAt = { x: +x.toFixed(2), z: +z.toFixed(2) }; }
      }
    }
  }

  return {
    ribbon: roads,
    carriageway: {
      worstStepOver025: +step.toFixed(3),
      at: stepAt,
      maxStepUp: 0.5,
      walkable: step < 0.5,
    },
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
