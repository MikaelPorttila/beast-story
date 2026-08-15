/**
 * The world map's marker icons — one atlas, drawn onto the map canvas. Packed by
 * tools/pack-map-icons.mjs from the 4x4 sheet; that tool and this file restate
 * the ORDER, so keep them in step. Imported, not in `public/`, for the
 * `base:'./'` reason (see ui/menu.ts).
 */
import atlasUrl from "./map-markers.webp";

/** Row-major, mirrors the sheet's own `markers` order and tools/pack-map-icons.mjs. */
export const MAP_ICONS = [
  "town",
  "encampment",
  "waypoint",
  "quest",
  "custom-player-marker",
  "point-of-interest",
  "boss",
  "unknown",
  "player",
  "party-member",
  "merchant",
  "healer",
  "blacksmith",
  "treasure",
  "dungeon-entrance",
  "shrine",
] as const;
export type MapIcon = (typeof MAP_ICONS)[number];

const COLS = 4;
/** Texels per tile in the packed atlas. */
const TILE = 128;
/** CSS px an icon is drawn at — the sheet's recommended default (32..48). */
export const MAP_ICON_SIZE = 40;

const atlas = new Image();
atlas.decoding = "async";
atlas.src = atlasUrl;

export const mapIconsReady = (): boolean => atlas.complete && atlas.naturalWidth > 0;

/** Centred on (x, y), rotated by `rot` radians about that centre. Draws nothing until the atlas has decoded. */
export function drawMapIcon(
  ctx: CanvasRenderingContext2D,
  icon: MapIcon,
  x: number,
  y: number,
  size = MAP_ICON_SIZE,
  rot = 0,
): void {
  if (!mapIconsReady()) {
    return;
  }
  const i = MAP_ICONS.indexOf(icon);
  const sx = (i % COLS) * TILE;
  const sy = Math.floor(i / COLS) * TILE;
  if (rot !== 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.drawImage(atlas, sx, sy, TILE, TILE, -size / 2, -size / 2, size, size);
    ctx.restore();
  } else {
    ctx.drawImage(atlas, sx, sy, TILE, TILE, x - size / 2, y - size / 2, size, size);
  }
}
