// The world map (issue #245): M opens it, its markers agree with the world,
// the one player marker round-trips to the compass, and clicking a lit
// waystone travels the hero there.
//
// Usage: bun tools/test-map.mjs
import { launchBrowser, newPage, wait, whenPlaying } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const browser = await launchBrowser();
const out = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const page = await newPage(browser, { width: 1280, height: 800 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${HOST}/?menu=0&fs=0&vol=0&nostore=1&${NO_WARMUP}`, { waitUntil: "load" });
await page.waitForSelector("canvas");
await whenPlaying(page);
await wait(400);

const dbgMap = () => page.evaluate(() => window.__dbgMap());
/** The fog's own colour, near enough: an RGBA pixel that is night-blue paper. */
const dark = (p) => p && p[0] < 40 && p[1] < 50 && p[2] < 60;

// ---------- 0. the closed map paints ahead, so it opens ready ---------------
{
  // A slice a frame under a small budget: give it a few seconds to catch up, then it must be caught up.
  let warm = null;
  for (let i = 0; i < 40; i++) {
    warm = (await dbgMap()).tiles;
    if (warm && warm.warm.queued > 0 && warm.warm.head === warm.warm.queued) {
      break;
    }
    await wait(150);
  }
  out.warm = warm;
  check(warm !== null && warm.cached > 0, "the closed map painted no tiles ahead");
  check(
    warm !== null && warm.warm.head === warm.warm.queued,
    `the warm queue is ${warm?.warm.head}/${warm?.warm.queued} after six seconds`,
  );
}

// ---------- 1. M opens it, and what it shows is what the world has ----------
{
  await page.keyboard.press("KeyM");
  await wait(350);
  const m = await dbgMap();
  out.openTiles = m.tiles;
  check(
    m.tiles.painted - out.warm.painted <= 4,
    `opening painted ${m.tiles.painted - out.warm.painted} more tiles: the warm-up missed the open level`,
  );
  const stones = await page.evaluate(() => window.__dbgWaypoints().all);
  const towns = await page.evaluate(() => window.__dbgTowns().towns);
  out.open = { open: m.open, stones: m.stones, lit: m.lit, towns: m.towns, quests: m.quests };
  check(m.open === true, "M did not open the map");
  check(
    m.stones === stones.length,
    `the map carries ${m.stones} stones, the world ${stones.length}`,
  );
  check(
    m.lit === stones.filter((s) => s.lit).length,
    `the map lights ${m.lit} stones, the character has lit ${stones.filter((s) => s.lit).length}`,
  );
  check(m.towns === towns.length, `the map carries ${m.towns} towns, the world ${towns.length}`);
  // It opens ON the hero, zoomed in, with the icon atlas decoded.
  const pos = await page.evaluate(() => window.__dbgPlayerPos());
  out.open.view = m.view;
  check(
    Math.abs(m.view.cx - pos.x) < 1 && Math.abs(m.view.cz - pos.z) < 1,
    `the map opened on (${m.view.cx}, ${m.view.cz}), the hero is at (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`,
  );
  // Zoomed IN on him: the short side of the view spans a few hundred world units, not the zone.
  const short = await page.evaluate(() => {
    const c = document.querySelector(".bs-map .mc");
    return Math.min(c.clientWidth, c.clientHeight);
  });
  out.open.spanAcross = +(short / m.view.scale).toFixed(0);
  check(
    short / m.view.scale < 420,
    `the map opened showing ${(short / m.view.scale).toFixed(0)} units across`,
  );
  check(m.icons === true, "the marker atlas has not decoded");
  // Fog of war: only the camp he stands in is known, and the far ground is covered.
  check(
    m.known.length === 1 && m.known[0] === "encampment",
    `towns known on a fresh character: ${JSON.stringify(m.known)}`,
  );
  check(m.explored > 0, "standing in the world explored nothing");
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "-" }));
    }
  });
  // Tiles paint a slice a frame; give the seen ones the few frames they need before reading pixels.
  await wait(500);
  const fog = await page.evaluate(() => {
    const c = document.querySelector(".bs-map .mc");
    const w = c.clientWidth;
    const h = c.clientHeight;
    return {
      far: window.__dbgMapPixel(w * 0.05, h * 0.05),
      here: window.__dbgMapPixel(w / 2, h / 2),
    };
  });
  out.fog = fog;
  check(dark(fog.far), `the far corner is not fogged: ${JSON.stringify(fog.far)}`);
  check(!dark(fog.here), `the ground under the hero is fogged: ${JSON.stringify(fog.here)}`);
  // The zoom-out floor covers the view: the map may not be smaller than the canvas.
  const floor = await dbgMap();
  // Painting is BUDGETED: after a full zoom-out and a zoom back in, the tiles painted so far
  // cost at most a slice per frame, and only tiles the fog has lifted were painted at all.
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));
    }
  });
  await wait(600);
  const t = (await dbgMap()).tiles;
  out.tiles = t;
  check(t.frames > 10, `the map drew ${t.frames} frames in 600 ms`);
  check(
    t.paintMs / t.frames < 4,
    `tile painting cost ${(t.paintMs / t.frames).toFixed(2)} ms a frame, over the 3 ms slice`,
  );
  check(t.painted > 0 && t.painted < 60, `${t.painted} tiles painted for one explored disc`);
  check(
    Math.abs(floor.view.scale - floor.view.minScale) < 1e-6,
    `zooming out stopped at ${floor.view.scale}, floor ${floor.view.minScale}`,
  );
}

// ---------- 2. the one player marker, and its compass chip ------------------
{
  // P plants the flag at the view centre; a second P on the same spot lifts it.
  await page.keyboard.press("KeyP");
  await wait(150);
  const planted = await dbgMap();
  const chip = await page.evaluate(
    () => window.__dbgCompass().markers.find((k) => k.id === "player-marker") ?? null,
  );
  out.marker = { planted: planted.planted, chip: chip?.id ?? null };
  check(planted.planted !== null, "P planted nothing");
  check(chip !== null, "the planted marker put no chip on the compass rim");
  check(
    chip !== null &&
      planted.planted !== null &&
      Math.abs(chip.x - planted.planted.x) < 0.5 &&
      Math.abs(chip.z - planted.planted.z) < 0.5,
    "the compass chip is not where the flag is",
  );

  await page.keyboard.press("KeyP");
  await wait(150);
  const lifted = await dbgMap();
  // The mouse: a LEFT click on bare ground plants nothing (a stray click while
  // panning must not move the flag); the MIDDLE button plants.
  const rect0 = await page.evaluate(() => {
    const r = document.querySelector(".bs-map .mc").getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const gx = rect0.left + rect0.w * 0.4;
  const gy = rect0.top + rect0.h * 0.6;
  await page.mouse.click(gx, gy);
  await wait(150);
  const afterLeft = (await dbgMap()).planted;
  await page.mouse.click(gx, gy, { button: "middle" });
  await wait(150);
  const afterMiddle = (await dbgMap()).planted;
  out.marker.mouse = { afterLeft, afterMiddle };
  check(afterLeft === null, "a left click on bare ground planted the flag");
  check(afterMiddle !== null, "a middle click on bare ground planted nothing");
  await page.mouse.click(gx, gy, { button: "middle" });
  await wait(150);
  check((await dbgMap()).planted === null, "a second middle click on the flag did not lift it");
  const chipAfter = await page.evaluate(
    () => window.__dbgCompass().markers.find((k) => k.id === "player-marker") ?? null,
  );
  out.marker.lifted = lifted.planted;
  check(lifted.planted === null, "a second P on the flag did not lift it");
  check(chipAfter === null, "the chip outlived the flag");
}

// ---------- 3. Escape closes it -----------------------------------------------
{
  await page.keyboard.press("Escape");
  await wait(300);
  const m = await dbgMap();
  out.escape = { open: m.open };
  check(m.open === false, "Escape did not close the map");
}

// ---------- 4. travel: a lit stone is a destination -------------------------
{
  // Light the nearest stone the way a player does — by standing at it.
  const stone = await page.evaluate(() => {
    const w = window.__dbgWaypoints().all[0];
    window.__dbgTp(w.x, w.z);
    window.__dbgAdvance(2);
    return window.__dbgWaypoints().all[0];
  });
  check(stone.lit === true, "standing at the stone did not light it");

  // Walk away so the travel below is a real displacement.
  const cachedBefore = (await dbgMap()).tiles.cached;
  await page.evaluate((s) => window.__dbgTp(s.x + 120, s.z + 80), stone);
  await wait(200);
  // New ground seen means new tiles to paint ahead — the warm-up follows the walk, not only the boot.
  let warmed = null;
  for (let i = 0; i < 40; i++) {
    warmed = (await dbgMap()).tiles;
    if (warmed.cached > cachedBefore && warmed.warm.head === warmed.warm.queued) {
      break;
    }
    await wait(150);
  }
  out.warmAfterWalk = { cachedBefore, cached: warmed.cached, ...warmed.warm };
  check(
    warmed.cached > cachedBefore && warmed.warm.head === warmed.warm.queued,
    `after walking, ${warmed.cached} tiles are cached (was ${cachedBefore}), queue ${warmed.warm.head}/${warmed.warm.queued}`,
  );

  await page.keyboard.press("KeyM");
  await wait(350);
  const m = await dbgMap();
  const target = m.screen.find((h) => h.id === stone.id);
  check(!!target, `the lit stone ${stone.id} is not clickable on the map`);
  if (target) {
    // Canvas-local -> page coordinates for a real click.
    const rect = await page.evaluate(() => {
      const r = document.querySelector(".bs-map .mc").getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    // A travel target is a thing you click, and the cursor says so — the pointer, as over a
    // button; the ground beside it is the draggable hand. Real mouse moves: the canvas's own
    // pointermove listener declares the state, so a synthetic window event would prove nothing.
    const cursorAt = async (x, y) => {
      await page.mouse.move(rect.left + x, rect.top + y);
      await wait(50);
      return page.evaluate(() => window.__dbgCursor().state);
    };
    const size = await page.evaluate(() => {
      const r = document.querySelector(".bs-map .mc").getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const bare = [
      [40, 40],
      [size.w - 40, 40],
      [40, size.h - 40],
      [size.w - 40, size.h - 40],
    ].find(([x, y]) => m.screen.every((h) => Math.hypot(h.x - x, h.y - y) > 60));
    out.cursor = { overStone: await cursorAt(target.x, target.y), overGround: null };
    check(
      out.cursor.overStone === "link-select",
      `over a lit stone the cursor resolved to "${out.cursor.overStone}"`,
    );
    if (bare) {
      out.cursor.overGround = await cursorAt(bare[0], bare[1]);
      check(
        out.cursor.overGround === "grab",
        `over bare map ground the cursor resolved to "${out.cursor.overGround}"`,
      );
    }
    await page.mouse.click(rect.left + target.x, rect.top + target.y);
    await wait(200);
    const asked = await dbgMap();
    out.travel = { confirm: asked.confirm };
    check(asked.confirm === stone.id, `the click asked about ${asked.confirm}, not the stone`);

    // The Travel button holds focus; Enter is the platform's click.
    await page.keyboard.press("Enter");
    await wait(400);
    const after = await dbgMap();
    const pos = await page.evaluate(() => window.__dbgPlayerPos());
    const d = Math.hypot(pos.x - stone.x, pos.z - stone.z);
    out.travel.after = { open: after.open, distance: +d.toFixed(2) };
    check(after.open === false, "travelling did not close the map");
    check(d < 8, `the hero landed ${d.toFixed(1)} units from the stone he travelled to`);
  }
}

// ---------- 5. untouched fog chunks cover cached coarse terrain ------------
{
  const origin = await page.evaluate(() => window.__dbgPlayerPos());
  const destination = { x: origin.x + 10000, z: origin.z + 10000 };
  await page.evaluate((p) => window.__dbgTp(p.x, p.z), destination);
  await wait(500);
  await page.keyboard.press("KeyM");
  await wait(300);
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "-" }));
    }
  });
  await wait(1200);

  const gap = await page.evaluate(
    ({ origin: start, destination: end }) => {
      const map = window.__dbgMap();
      const canvas = document.querySelector(".bs-map .mc");
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const level = Math.min(
        5,
        Math.max(0, Math.floor(Math.log2(16 * map.view.scale * window.devicePixelRatio))),
      );
      const tileWidth = (128 * 16) / (1 << level);
      const tx = Math.floor(end.x / tileWidth);
      const tz = Math.floor(end.z / tileWidth);
      const candidates = [];
      for (
        let z = Math.floor((tz * tileWidth) / 512);
        z <= Math.floor(((tz + 1) * tileWidth - 1) / 512);
        z++
      ) {
        for (
          let x = Math.floor((tx * tileWidth) / 512);
          x <= Math.floor(((tx + 1) * tileWidth - 1) / 512);
          x++
        ) {
          const wx = (x + 0.5) * 512;
          const wz = (z + 0.5) * 512;
          const sx = w / 2 + (wx - map.view.cx) * map.view.scale;
          const sy = h / 2 + (wz - map.view.cz) * map.view.scale;
          const nearest = Math.min(
            Math.hypot(wx - start.x, wz - start.z),
            Math.hypot(wx - end.x, wz - end.z),
          );
          if (sx > 2 && sx < w - 2 && sy > 2 && sy < h - 2 && nearest > 300) {
            candidates.push({ wx, wz, sx, sy, nearest });
          }
        }
      }
      candidates.sort((a, b) => b.nearest - a.nearest);
      const sample = candidates[0] ?? null;
      return {
        level,
        tileWidth,
        sample,
        pixel: sample ? window.__dbgMapPixel(sample.sx, sample.sy) : null,
      };
    },
    { origin, destination },
  );
  out.untouchedChunk = gap;
  check(
    gap.sample !== null,
    `no untouched fog chunk was visible in the ${gap.tileWidth}-unit terrain tile`,
  );
  check(dark(gap.pixel), `an untouched fog chunk exposed cached terrain: ${JSON.stringify(gap)}`);
}

console.log(JSON.stringify(out, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) {
    console.error(`  ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
