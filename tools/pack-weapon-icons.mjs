// Repack the issue #74 weapon/blueprint art into the atlas the inventory reads.
//
// ONE-OFF, AND COMMITTED ON PURPOSE. The output (src/ui/weapons.webp) is what
// ships; this file is how it was made, which is the only thing that makes the
// numbers below auditable. Re-run it if the source art changes:
//
//   bun tools/pack-weapon-icons.mjs <source.png> [out.webp]
//
// The source is the 1536x1024 sheet attached to the issue, and SPRITES is the
// rect list the generator reported with it — copied verbatim, not re-measured,
// because a rect nudged by eye is a rect nobody can check against the ticket.
//
// WHY AN ATLAS AND NOT TEN FILES. Same argument as ui/cursor.ts: one request,
// one decode, one content hash. The difference is what reads it — a CSS cursor
// needs `url()` per state so cursor.ts slices to ten data URIs at boot, where an
// inventory slot is an ordinary element, so ui/weapon-icons.ts hands CSS a
// `background-position` and the browser does the slicing for free. No canvas at
// runtime, nothing to await, and the icons are there on the panel's first paint.
//
// WHY A BROWSER DOES THE PACKING. puppeteer-core is already a dev dependency and
// tools/browser.mjs already knows how to start one; a canvas crops, scales and
// encodes webp with alpha in three lines. ImageMagick is not installed on this
// machine and adding a native image dependency to pack one asset once is the
// wrong trade.
import { writeFile, readFile } from "node:fs/promises";
import { launchBrowser, newPage } from "./browser.mjs";

/** Rects in the SOURCE sheet, top-left origin. Verbatim from the issue. */
const SPRITES = {
  largeSword: { x: 305, y: 80, width: 133, height: 306 },
  oneHandedSword: { x: 545, y: 120, width: 104, height: 266 },
  bow: { x: 735, y: 120, width: 148, height: 269 },
  scythe: { x: 915, y: 120, width: 233, height: 270 },
  dagger: { x: 1228, y: 145, width: 100, height: 241 },
  largeSwordBlueprint: { x: 310, y: 545, width: 128, height: 293 },
  oneHandedSwordBlueprint: { x: 545, y: 580, width: 106, height: 256 },
  bowBlueprint: { x: 735, y: 570, width: 146, height: 268 },
  scytheBlueprint: { x: 910, y: 568, width: 240, height: 271 },
  daggerBlueprint: { x: 1228, y: 588, width: 101, height: 249 },
};

// The order the atlas is laid out in, five to a row: weapons on row 0,
// blueprints on row 1, so a tile index is (row * 5 + column) and the two rows
// are the same five shapes in the same five columns. ui/weapon-icons.ts
// restates this list and the two must not drift.
const ORDER = Object.keys(SPRITES);
const COLS = 5;

// 128 rather than 64: unlike a cursor there is no browser cap here, an
// inventory slot is drawn at 56-72 CSS px, and a phone at devicePixelRatio 3
// asks for more than 64 of them. Measured, the whole atlas is well under the
// source's 502 KB either way.
const TILE = 128;
const PAD = 4; // keeps the longest blade off its neighbour's edge

const src = process.argv[2];
const out = process.argv[3] ?? "src/ui/weapons.webp";
if (!src) {
  console.error("usage: bun tools/pack-weapon-icons.mjs <source.png> [out.webp]");
  process.exit(2);
}

const dataUri = `data:image/png;base64,${(await readFile(src)).toString("base64")}`;

const browser = await launchBrowser();
try {
  const page = await newPage(browser, { width: 400, height: 300 });
  const result = await page.evaluate(
    async (uri, sprites, order, cols, tile, pad) => {
      const img = new Image();
      img.src = uri;
      await img.decode();
      const rows = Math.ceil(order.length / cols);
      const c = document.createElement("canvas");
      c.width = cols * tile;
      c.height = rows * tile;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      const fitted = {};
      order.forEach((name, i) => {
        const r = sprites[name];
        // Fit inside the cell preserving aspect, then centre. Every sprite is
        // taller than it is wide except the scythe, so this is what stops the
        // scythe being drawn at a different apparent scale from the swords.
        const k = Math.min((tile - pad * 2) / r.width, (tile - pad * 2) / r.height);
        const w = Math.round(r.width * k);
        const h = Math.round(r.height * k);
        const dx = (i % cols) * tile + Math.round((tile - w) / 2);
        const dy = Math.floor(i / cols) * tile + Math.round((tile - h) / 2);
        ctx.drawImage(img, r.x, r.y, r.width, r.height, dx, dy, w, h);
        fitted[name] = { w, h };
      });
      return { url: c.toDataURL("image/webp", 0.92), fitted, w: c.width, h: c.height };
    },
    dataUri,
    SPRITES,
    ORDER,
    COLS,
    TILE,
    PAD,
  );

  const bytes = Buffer.from(result.url.split(",")[1], "base64");
  await writeFile(out, bytes);
  console.log(
    JSON.stringify(
      {
        out,
        atlas: `${result.w}x${result.h}`,
        tile: TILE,
        cols: COLS,
        bytes: bytes.length,
        drawn: result.fitted,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
