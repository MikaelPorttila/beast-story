// Repack the world-map marker sheet into the atlas ui/map-icons.ts draws from.
//
// ONE-OFF, AND COMMITTED ON PURPOSE — same argument as pack-weapon-icons.mjs:
// the output (src/ui/map-markers.webp) ships, this file is how it was made.
//
//   bun tools/pack-map-icons.mjs <map-markers.png> [out.webp]
//
// The source is the 1024x1024 sheet, a 4x4 grid of 256px cells in the order
// ui/map-icons.ts lists (its own JSON map says the same: row-major, top-left
// origin). Cells are scaled to 128px: an icon is drawn at 32-48 CSS px, so a
// dpr-3 phone asks for at most 144 texels and 128 keeps the atlas small.
import { writeFile, readFile } from "node:fs/promises";
import { launchBrowser, newPage } from "./browser.mjs";

const SRC_CELL = 256;
const COLS = 4;
const ROWS = 4;
const TILE = 128;

const src = process.argv[2];
const out = process.argv[3] ?? "src/ui/map-markers.webp";
if (!src) {
  console.error("usage: bun tools/pack-map-icons.mjs <map-markers.png> [out.webp]");
  process.exit(2);
}

const dataUri = `data:image/png;base64,${(await readFile(src)).toString("base64")}`;

const browser = await launchBrowser();
try {
  const page = await newPage(browser, { width: 400, height: 300 });
  const result = await page.evaluate(
    async (uri, srcCell, cols, rows, tile) => {
      const img = new Image();
      img.src = uri;
      await img.decode();
      if (img.naturalWidth !== srcCell * cols || img.naturalHeight !== srcCell * rows) {
        throw new Error(
          `expected ${srcCell * cols}x${srcCell * rows}, got ${img.naturalWidth}x${img.naturalHeight}`,
        );
      }
      const c = document.createElement("canvas");
      c.width = cols * tile;
      c.height = rows * tile;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return { url: c.toDataURL("image/webp", 0.92), w: c.width, h: c.height };
    },
    dataUri,
    SRC_CELL,
    COLS,
    ROWS,
    TILE,
  );

  const bytes = Buffer.from(result.url.split(",")[1], "base64");
  await writeFile(out, bytes);
  console.log(
    JSON.stringify({ out, atlas: `${result.w}x${result.h}`, tile: TILE, bytes: bytes.length }),
  );
} finally {
  await browser.close();
}
