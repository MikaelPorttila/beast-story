// Repack the world-map marker sheet into the atlas ui/map-icons.ts draws from.
//
// ONE-OFF, AND COMMITTED ON PURPOSE — same argument as pack-weapon-icons.mjs:
// the output (src/ui/map-markers.webp) ships, this file is how it was made.
//
//   bun tools/pack-map-icons.mjs <map-markers.png> [out.webp]
//
// The source is a square 4x4 grid in the order ui/map-icons.ts lists (its own
// JSON map says the same: row-major, top-left origin). The whole sheet is
// scaled to 512px, so a cell is 128px: an icon is drawn at 32-48 CSS px, so a
// dpr-3 phone asks for at most 144 texels and 128 keeps the atlas small.
// ffmpeg rather than a browser canvas because it is on the machine and one
// resize needs no page.
import { spawnSync } from "node:child_process";

const SIZE = 512;

const src = process.argv[2];
const out = process.argv[3] ?? "src/ui/map-markers.webp";
if (!src) {
  console.error("usage: bun tools/pack-map-icons.mjs <map-markers.png> [out.webp]");
  process.exit(2);
}

const r = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    src,
    "-vf",
    `scale=${SIZE}:${SIZE}:flags=lanczos`,
    "-quality",
    "92",
    out,
  ],
  { stdio: "inherit" },
);
if (r.error || r.status !== 0) {
  console.error(r.error?.message ?? `ffmpeg exited ${r.status}`);
  process.exit(1);
}
console.log(JSON.stringify({ out, atlas: `${SIZE}x${SIZE}`, tile: SIZE / 4 }));
