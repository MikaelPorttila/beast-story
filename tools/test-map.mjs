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

// ---------- 1. M opens it, and what it shows is what the world has ----------
{
  await page.keyboard.press("KeyM");
  await wait(350);
  const m = await dbgMap();
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
  await page.evaluate((s) => window.__dbgTp(s.x + 120, s.z + 80), stone);
  await wait(200);

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

console.log(JSON.stringify(out, null, 2));
if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) {
    console.error(`  ${f}`);
  }
}
await browser.close();
process.exit(fails.length ? 1 : 0);
