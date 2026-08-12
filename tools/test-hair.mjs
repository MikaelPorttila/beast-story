// Verifies the hero's hair: eight styles that are eight DIFFERENT heads, a
// colour that reaches the geometry, a choice that survives a reload, and two
// rows in the F3 panel that do all of it by being clicked.
//
// Usage: bun tools/test-hair.mjs        (dev server must be up)
//
// WHAT IT ASSERTS ON, AND WHY IT IS NOT THE FLAG. `__dbgHair()` reports the id
// it was set to, and a probe that checked only that would pass a build where
// every style paints the same cap: the id is the request, not the result. So
// the assertions are on the MESH — its vertex count, which is a property of the
// shape somebody painted, and its mean vertex colour, which is where a hair
// colour ends up (VoxelModel bakes colour into the attribute; there is no
// material to tint). Eight distinct counts is eight distinct heads.
//
// Exits non-zero.
import { frame, launchBrowser, newContextPage, whenPlaying } from "./browser.mjs";
import { BASE as HOST, NO_WARMUP } from "./target.mjs";

const browser = await launchBrowser();
const out = {};
const fails = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
  }
};

const { ctx, page } = await newContextPage(browser, { width: 900, height: 600 });
// NO_WARMUP: nothing here times a frame — the hair is geometry, and every
// reading below comes off the model rather than off the picture.
const url = `${HOST}/?fps=30&menu=0&vol=0&${NO_WARMUP}`;
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("canvas");
await whenPlaying(page);

// THREE ENTRY POINTS, NOT ONE WITH OPTIONAL ARGUMENTS. `page.evaluate`
// serialises its argument as JSON and JSON has no `undefined` — a missing
// colour arrives as null, which the hook reads as "clear the pick" and puts the
// default head back. The first cut of this probe did exactly that and reported
// that all eight styles were `classic`. tools/test-gfx.mjs carries the same
// note for the same reason.
const readHair = () => page.evaluate(() => window.__dbgHair());
const setStyle = (style) => page.evaluate((s) => window.__dbgHair(s), style);
const setHair = (style, colour) =>
  page.evaluate(([s, c]) => window.__dbgHair(s, c), [style, colour]);

// -- 1. every style is its own head ------------------------------------------
const first = await readHair();
out.default = { style: first.style, colour: first.colour, vertices: first.vertices };
check(first.styles.length >= 8, `expected at least 8 styles, got ${first.styles.length}`);
check(first.vertices > 0, "the default style built no geometry");

const shapes = {};
for (const id of first.styles) {
  const r = await setStyle(id);
  shapes[id] = { vertices: r.vertices, colour: r.colour, tint: r.tint };
  check(r.style === id, `asked for ${id}, got ${r.style}`);
  check(r.vertices > 200, `${id} built only ${r.vertices} vertices — that is not a hairstyle`);
}
out.styles = shapes;
const counts = Object.values(shapes).map((s) => s.vertices);
const duplicates = counts.length - new Set(counts).size;
out.distinctShapes = new Set(counts).size;
check(
  duplicates === 0,
  `${duplicates} styles share a vertex count — two of them are the same head`,
);

// A style with no colour picked is drawn in its OWN — the default is the
// absence of a stored key, and this is the half of that rule a probe can see.
out.suggestedColoursDiffer = new Set(Object.values(shapes).map((s) => s.colour)).size;
check(out.suggestedColoursDiffer > 1, "every style came out the same colour with no pick made");

// -- 2. a picked colour reaches the geometry ---------------------------------
const green = await setHair("classic", "20d060");
const red = await setHair("classic", "d02020");
out.colour = {
  green: { colour: green.colour, tint: green.tint },
  red: { colour: red.colour, tint: red.tint },
};
check(green.colour === "20d060", `colour not stored: ${green.colour}`);
check(
  green.tint[1] > green.tint[0] && green.tint[1] > green.tint[2],
  "a green head is not green in the mesh",
);
check(red.tint[0] > red.tint[1] && red.tint[0] > red.tint[2], "a red head is not red in the mesh");
// The SHAPE must not have moved with the colour — a recolour rebuilds the same
// model, and a count that changed would mean the paint depends on the palette.
check(
  green.vertices === shapes.classic.vertices,
  `recolouring changed the shape: ${shapes.classic.vertices} -> ${green.vertices}`,
);

// -- 3. the F3 panel's two rows ----------------------------------------------
await setHair("classic", "20d060");
await page.keyboard.press("F3");
await frame(page);
await frame(page);
const rows = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".bs-perf-row[data-hair]")];
  return {
    open: el.length,
    ids: el.map((r) => r.getAttribute("data-hair")),
    styleShown: el[0]?.querySelector(".bs-perf-val")?.textContent ?? null,
    well: document.querySelector(".bs-hair-well")?.getAttribute("value") ?? null,
  };
});
out.panel = rows;
check(rows.open === 2, `expected a style row and a colour row, found ${rows.open}`);
check(rows.ids.join() === "style,colour", `unexpected rows: ${rows.ids.join()}`);
check(rows.well === "#20d060", `the well shows ${rows.well}, not the colour in use`);

// A CLICK, not the hook — the row is what a person uses, and the host's own
// mousedown listener is part of the path being tested.
const before = await readHair();
await page.evaluate(() => {
  const row = document.querySelector('.bs-perf-row[data-hair="style"]');
  row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
});
await frame(page);
const after = await readHair();
out.click = { from: before.style, to: after.style, vertices: after.vertices };
check(after.style !== before.style, "clicking the style row changed nothing");
check(after.vertices !== before.vertices, "the style id moved but the mesh did not");
// The colour survives a style change: it is the player's pick and outranks
// every style's own suggestion.
check(after.colour === "20d060", `a style change lost the picked colour (${after.colour})`);

// -- 4. it is remembered ------------------------------------------------------
const chosen = after.style;
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("canvas");
await whenPlaying(page);
const reloaded = await readHair();
out.persisted = { style: reloaded.style, colour: reloaded.colour };
check(reloaded.style === chosen, `after a reload: ${reloaded.style}, expected ${chosen}`);
check(reloaded.colour === "20d060", `after a reload the colour was ${reloaded.colour}`);

// Leave the profile as it was found — the next probe on this machine boots the
// hero the game ships with.
await page.evaluate(() => window.__dbgHair("classic", null));
const cleared = await readHair();
out.cleared = { style: cleared.style, colour: cleared.colour };
check(
  cleared.colour === shapes.classic.colour,
  `clearing the pick left ${cleared.colour}, not the style's own ${shapes.classic.colour}`,
);

await ctx.close();
await browser.close();

out.pass = fails.length === 0;
if (fails.length) {
  out.failures = fails;
}
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
