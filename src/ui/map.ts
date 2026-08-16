import { t } from "../i18n";
import { injectStyles } from "./styles";
import { seedPadButtons } from "../core/gamepad";
import { CLOSE_ICON } from "./icons";
import { drawMapIcon, MAP_ICON_SIZE, mapIconsReady } from "./map-icons";
import { cellOf, EXPLORE_CELL } from "../world/exploration";

/**
 * Fullscreen world map (issue #245). The panel owns the screen — pan, zoom and
 * focus — and reports every world-changing intent to its host: main.ts decides
 * what a teleport or a placed marker MEANS. It is a modal in the journal's
 * mould: host-owned hotkey (`M`), Escape routed through the host, gamepad via
 * its own pollPad while a panel is up.
 *
 * The map IMAGE is generated like everything else the game draws: terrain
 * height and water sampled into a pyramid of tiles, painted on demand at the
 * zoom being looked at, cached per zone. Fog of war hides what the character
 * has not walked (world/exploration.ts). The world has NO EDGE — the engine
 * grows it from its seed as far as anyone walks — so nothing here is sized to
 * a zone: tiles and fog chunks are addressed by world coordinate and made when
 * first needed, and the pannable extent is what has been explored so far.
 */

export type MapCloseBy = "escape" | "hotkey" | "click" | "travel";

export interface MapTown {
  id: string;
  name: string;
  color: number;
  x: number;
  z: number;
  kind: "camp" | "hamlet" | "harbour";
  /** Seen, or sent to by a quest. An unknown town is not drawn: the world is not spoiled by data. */
  known: boolean;
}

export interface MapStone {
  id: string;
  x: number;
  z: number;
  /** Touched and therefore a travel target. Unlit stones are not drawn at all. */
  lit: boolean;
}

export interface MapQuestSpot {
  id: string;
  name: string;
  x: number;
  z: number;
}

export interface MapModel {
  towns: readonly MapTown[];
  stones: readonly MapStone[];
  quests: readonly MapQuestSpot[];
  player: { x: number; z: number; facing: number };
  marker: { x: number; z: number } | null;
}

/** What the base image is painted from. `roads()` are [x, z] polylines, asked per tile: the world adds roads as it grows. */
export interface MapTerrain {
  zoneId: string;
  heightAt(x: number, z: number): number;
  waterLevel: number;
  roads(): ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Explored cell keys for this zone (`cellKey`), insertion-ordered so the fog can paint incrementally. */
  explored(): ReadonlySet<number>;
}

export interface MapHooks {
  model(): MapModel;
  /** The zone the hero is in now — cheap, asked every frame; `terrain()` is only asked when it changes. */
  zoneId(): string;
  terrain(): MapTerrain;
  /** A confirmed click on a lit stone. The host travels and closes the panel. */
  onTravel(stoneId: string): void;
  /** Place (or move) the one player marker. Null clears it. */
  onMarker(spot: { x: number; z: number } | null): void;
  onOpen?(): void;
  onClose?(by: MapCloseBy): void;
}

/** Texels on a tile's side. Small: one tile is ~8 ms of sampling, a frame's worth. */
const TILE = 128;
/** World units per texel at level 0; each level halves it. Level 0 tiles are 2048 units — a zone's worth of stand-in. */
const UPT0 = 16;
/** Levels 0..LEVELS-1, the deepest at half a unit per texel: the ground is voxels, so finer buys nothing. */
const LEVELS = 6;
const uptOf = (level: number): number => UPT0 / (1 << level);
/** The level whose texel is one to two device pixels at this zoom (floor: a zoom crosses fewer levels). */
const levelFor = (scale: number, dpr: number): number =>
  Math.min(LEVELS - 1, Math.max(0, Math.floor(Math.log2(UPT0 * scale * dpr))));
/** Milliseconds a frame may spend sampling tiles: a slice, never a whole tile, so pan and zoom never wait on one. */
const TILE_BUDGET_MS = 3;
/** Rows sampled between budget checks; ~0.3 ms at the deepest level. */
const ROW_SLICE = 8;
/** Milliseconds a game frame lends the CLOSED map to paint ahead, so the panel opens with its tiles ready. */
const WARM_BUDGET_MS = 2;
/** Tiles handed to the painter per warm frame — a slice paints one, the rest keep the queue's order. */
const WARM_BATCH = 6;
/** World units per "seen" block; a tile whose rect touches no seen block is fog and is never painted. */
const SEEN_BLOCK = 64;
/** Tiles kept per zone before the oldest above level 0 go. Warming paints every seen tile at the open level, so a whole explored zone must fit; ~64 KB each. */
const TILE_CACHE_MAX = 1500;
/** Pixels of screen the map may zoom a world unit up to. */
const MAX_SCALE = 6;
/** World units across the SHORTER side of the view when the map opens on the hero. */
const OPEN_SPAN = 360;
/** World units per fog texel; the brush is soft, so coarse is fine and cheap. */
const FOG_TEXEL = 4;
/** Fog is kept in square chunks this many world units wide, made as the walk reaches them. */
const FOG_CHUNK = 512;
/** Sea room past the explored extent that the view may pan and zoom out to. */
const EXTENT_MARGIN = 320;
/** Screen px within which a click hits a marker: an icon's own half-size. */
const HIT_R = 24;
/** Keyboard pan speed, world units per frame at scale 1 — divided by scale so it is a screen speed. */
const KEY_PAN = 14;
const FOG_COLOUR = "#101821";

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const tileKey = (level: number, i: number, j: number): string => `${level}:${i}:${j}`;

/** Everything painted for one zone; kept for the session — terrain does not change under a zone. */
interface ZoneMap {
  tiles: Map<string, HTMLCanvasElement>;
  /** `cx,cz` chunk → its sheet, opaque where unseen. A chunk no walk has reached has no sheet and is all fog. */
  fog: Map<string, HTMLCanvasElement>;
  /** Bounding box of every explored cell, world units — the extent the view may roam. Null until anything is seen. */
  extent: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  /** How many explored cells the fog canvas already has holes for. */
  fogPainted: number;
  /** The explored set being mirrored; restore replaces its identity and invalidates every cached hole. */
  fogSource: ReadonlySet<number> | null;
  /** `bx,bz` of every SEEN_BLOCK an explored cell touches — the painter's "is any of this tile visible" test. */
  seen: Set<string>;
}

/** A tile half-sampled: rows [0, row) of `heights` are filled, the rest are this frame's or the next's. */
interface TileJob {
  level: number;
  i: number;
  j: number;
  upt: number;
  x0: number;
  z0: number;
  ap: number;
  n: number;
  row: number;
}

/** One interactive thing on the map this frame, in world coordinates. */
interface Hot {
  kind: "stone" | "marker";
  id: string;
  x: number;
  z: number;
}

/** A soft disc two cells across; a hole per explored cell, and their union is the seen ground. */
function makeFogBrush(): HTMLCanvasElement {
  const r = Math.ceil((EXPLORE_CELL * 1.6) / FOG_TEXEL);
  const c = document.createElement("canvas");
  c.width = r * 2;
  c.height = r * 2;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.5, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, r * 2, r * 2);
  return c;
}

/** The hillshade reads slope over this many world units, so a voxel step does not draw as a contour line. */
const SHADE_REACH = 3;
const APRON_MAX = 6;
/** Height scratch for one tile plus the apron the hillshade gradient reaches into. */
const heights = new Float32Array((TILE + 2 * APRON_MAX) * (TILE + 2 * APRON_MAX));

export class MapPanel {
  private el: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly cache = new Map<string, ZoneMap>();
  private zone: ZoneMap | null = null;
  private terrain: MapTerrain | null = null;
  /** Tiles the last frame wanted and did not have, nearest the view centre first. */
  private pending: Array<{ level: number; i: number; j: number; d: number }> = [];
  private job: TileJob | null = null;
  /** Tiles the closed panel paints ahead, in the order the player will want them; `warmHead` is how far it got. */
  private warmQueue: Array<{ level: number; i: number; j: number; d: number }> = [];
  private warmHead = 0;
  private warmFor = -1;
  private fogBrush: HTMLCanvasElement | null = null;
  /** Session totals, for a probe: how much of the game frame the map has spent painting tiles. */
  private painted = 0;
  private paintMs = 0;
  private frames = 0;

  /** View: world point at the canvas centre, and screen px per world unit. */
  private cx = 0;
  private cz = 0;
  private scale = 1;
  private minScale = 0.1;

  private raf = 0;
  private hots: Hot[] = [];
  /** Index into `hots` the keyboard/pad focus ring sits on, or -1 for none. */
  private focus = -1;
  private confirmEl: HTMLDivElement | null = null;
  private confirmStone: string | null = null;

  private dragging = false;
  private dragMoved = false;
  private lastX = 0;
  private lastY = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private padRaf = 0;
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  /** True when the last focus move came from a key or pad — draws the crosshair. */
  private steering = false;
  private readonly keysHeld = new Set<string>();

  constructor(private hooks: MapHooks) {
    injectStyles();
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(): void {
    if (this.el) {
      return;
    }
    const el = document.createElement("div");
    el.className = "bs-map";
    el.innerHTML =
      '<div class="bs-scrim"></div>' +
      '<div class="pane bs-glass">' +
      `<div class="head"><h2>${escapeHtml(t("map.title"))}</h2><span class="cap"><kbd>M</kbd><kbd>Esc</kbd></span></div>` +
      '<canvas class="mc"></canvas>' +
      `<div class="foot">${this.hintHtml()}</div>` +
      "</div>";
    this.el = el;
    document.body.appendChild(el);

    const closeBtn = document.createElement("button");
    closeBtn.className = "bs-shop-x";
    closeBtn.type = "button";
    closeBtn.dataset.act = "close";
    closeBtn.innerHTML = CLOSE_ICON;
    (el.querySelector(".head") as HTMLElement).appendChild(closeBtn);

    this.canvas = el.querySelector(".mc") as HTMLCanvasElement;
    this.canvas.dataset.cursor = "grab";
    this.ctx = this.canvas.getContext("2d");

    el.addEventListener("click", this.onClick);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.bindZone();
    this.resetView();
    this.focus = -1;
    this.steering = false;
    this.frame();
    seedPadButtons(this.padDown);
    this.pollPad();
    requestAnimationFrame(() => el.classList.add("open"));
    this.hooks.onOpen?.();
  }

  close(by: MapCloseBy = "click"): void {
    if (!this.el) {
      return;
    }
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    this.padDown.fill(0);
    this.keysHeld.clear();
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    this.dismissConfirm();
    this.el.remove();
    this.el = null;
    this.canvas = null;
    this.ctx = null;
    this.pending = [];
    this.job = null;
    this.pointers.clear();
    this.dragging = false;
    this.hooks.onClose?.(by);
  }

  toggle(): void {
    if (this.el) {
      this.close("hotkey");
    } else {
      this.open();
    }
  }

  /** Returns whether this panel SPENT the press. The confirm dialog goes first. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    if (this.confirmEl) {
      this.dismissConfirm();
      return true;
    }
    this.close("escape");
    return true;
  }

  /** The host's confirm edge (pad X arrives here as KeyE): act on the focused thing. */
  activate(): void {
    if (!this.el) {
      return;
    }
    if (this.confirmEl) {
      (document.activeElement as HTMLButtonElement | null)?.click();
      return;
    }
    const hot = this.hots[this.focus];
    if (hot) {
      this.actOn(hot);
    }
  }

  dispose(): void {
    this.close();
  }

  /** A probe's window into the live view — screen positions included, so a click can be aimed. */
  debug(): unknown {
    const model = this.hooks.model();
    return {
      open: this.isOpen,
      view: {
        cx: +this.cx.toFixed(1),
        cz: +this.cz.toFixed(1),
        scale: +this.scale.toFixed(3),
        minScale: +this.minScale.toFixed(3),
      },
      confirm: this.confirmStone,
      focus: this.hots[this.focus]?.id ?? null,
      towns: model.towns.length,
      known: model.towns.filter((tn) => tn.known).map((tn) => tn.id),
      stones: model.stones.length,
      lit: model.stones.filter((s) => s.lit).length,
      quests: model.quests.length,
      marker: model.marker,
      icons: mapIconsReady(),
      tiles: this.zone
        ? {
            cached: this.zone.tiles.size,
            pending: this.pending.length,
            fogPainted: this.zone.fogPainted,
            painted: this.painted,
            paintMs: +this.paintMs.toFixed(1),
            frames: this.frames,
            warm: { queued: this.warmQueue.length, head: this.warmHead },
          }
        : null,
      screen: this.isOpen
        ? this.hots.map((h) => {
            const p = this.toScreen(h.x, h.z);
            return { id: h.id, kind: h.kind, x: Math.round(p.x), y: Math.round(p.y) };
          })
        : [],
    };
  }

  /** Reads one canvas pixel back, in CSS px — a probe's proof that fog covers, or does not. */
  pixelAt(sx: number, sy: number): [number, number, number, number] | null {
    if (!this.canvas || !this.ctx) {
      return null;
    }
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const d = this.ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  /**
   * A frame's worth of painting AHEAD while the panel is closed: the fog record
   * and the tiles the panel would open on, nearest the hero first, a slice per
   * frame. The host calls it every game frame; it does nothing once caught up.
   */
  warm(): void {
    if (this.el) {
      return;
    }
    this.bindZone();
    const zm = this.zone;
    const ter = this.terrain;
    if (!zm || !ter) {
      return;
    }
    this.paintFog(zm, ter.explored());
    if (this.warmFor !== zm.fogPainted) {
      this.buildWarmQueue(zm);
    }
    const q = this.warmQueue;
    while (
      this.warmHead < q.length &&
      zm.tiles.has(tileKey(q[this.warmHead].level, q[this.warmHead].i, q[this.warmHead].j))
    ) {
      this.warmHead++;
    }
    if (this.warmHead >= q.length) {
      return;
    }
    this.pending = q.slice(this.warmHead, this.warmHead + WARM_BATCH);
    this.paintPending(WARM_BUDGET_MS);
  }

  /** Terrain and zone map for the hero's zone; asked of the host only when the zone changes. */
  private bindZone(): void {
    const id = this.hooks.zoneId();
    if (this.terrain?.zoneId === id && this.zone) {
      return;
    }
    this.terrain = this.hooks.terrain();
    this.zone = this.zoneMap(this.terrain);
    this.job = null;
    this.pending = [];
    this.warmQueue = [];
    this.warmHead = 0;
    this.warmFor = -1;
  }

  /**
   * Every tile the fog has lifted, at the level the panel opens on and the one
   * above it (its stand-in), plus the whole-zone tile: level 0 first, then
   * coarse to fine, nearest the hero first within a level.
   */
  private buildWarmQueue(zm: ZoneMap): void {
    this.warmFor = zm.fogPainted;
    // The panel's canvas is not laid out yet; the window is what it will fill, less the head and foot.
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight - 110);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const open = levelFor(Math.min(MAX_SCALE, Math.min(w, h) / OPEN_SPAN), dpr);
    const levels = [...new Set([0, Math.max(0, open - 1), open])];
    const p = this.hooks.model().player;
    const pad = EXPLORE_CELL * 2;
    const out: Array<{ level: number; i: number; j: number; d: number; rank: number }> = [];
    levels.forEach((level, rank) => {
      const tw = TILE * uptOf(level);
      const seen = new Set<string>();
      for (const key of zm.seen) {
        const [bx, bz] = key.split(",").map(Number);
        const i0 = Math.floor((bx * SEEN_BLOCK - pad) / tw);
        const i1 = Math.floor(((bx + 1) * SEEN_BLOCK + pad) / tw);
        const j0 = Math.floor((bz * SEEN_BLOCK - pad) / tw);
        const j1 = Math.floor(((bz + 1) * SEEN_BLOCK + pad) / tw);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = tileKey(level, i, j);
            if (seen.has(k) || zm.tiles.has(k)) {
              continue;
            }
            seen.add(k);
            const dx = (i + 0.5) * tw - p.x;
            const dz = (j + 0.5) * tw - p.z;
            out.push({ level, i, j, d: dx * dx + dz * dz, rank });
          }
        }
      }
    });
    out.sort((a, c) => a.rank - c.rank || a.d - c.d);
    this.warmQueue = out;
    this.warmHead = 0;
  }

  // ---- the base image: a tile pyramid, painted on demand -----------------------

  private zoneMap(ter: MapTerrain): ZoneMap {
    const hit = this.cache.get(ter.zoneId);
    if (hit) {
      return hit;
    }
    const made: ZoneMap = {
      tiles: new Map(),
      fog: new Map(),
      extent: null,
      fogPainted: 0,
      fogSource: null,
      seen: new Set(),
    };
    this.cache.set(ter.zoneId, made);
    return made;
  }

  /** Does the fog lift anywhere over this tile? Blocks are coarse, so this is a handful of lookups. */
  private tileSeen(zm: ZoneMap, level: number, i: number, j: number): boolean {
    const tw = TILE * uptOf(level);
    // A brush reaches past its cell; a tile beside seen ground shows a soft edge of it.
    const pad = EXPLORE_CELL * 2;
    const bx0 = Math.floor((i * tw - pad) / SEEN_BLOCK);
    const bx1 = Math.floor(((i + 1) * tw + pad) / SEEN_BLOCK);
    const bz0 = Math.floor((j * tw - pad) / SEEN_BLOCK);
    const bz1 = Math.floor(((j + 1) * tw + pad) / SEEN_BLOCK);
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        if (zm.seen.has(`${bx},${bz}`)) {
          return true;
        }
      }
    }
    return false;
  }

  private startTile(level: number, i: number, j: number): TileJob {
    const upt = uptOf(level);
    const ap = Math.min(APRON_MAX, Math.max(1, Math.round(SHADE_REACH / upt)));
    return {
      level,
      i,
      j,
      upt,
      x0: i * TILE * upt,
      z0: j * TILE * upt,
      ap,
      n: TILE + 2 * ap,
      row: 0,
    };
  }

  /** Sample the next slice of rows. True when the whole tile is in `heights`. */
  private sampleRows(ter: MapTerrain, job: TileJob): boolean {
    const { n, ap, upt, x0, z0 } = job;
    const end = Math.min(n, job.row + ROW_SLICE);
    for (let jj = job.row; jj < end; jj++) {
      const z = z0 + (jj - ap + 0.5) * upt;
      for (let ii = 0; ii < n; ii++) {
        heights[jj * n + ii] = ter.heightAt(x0 + (ii - ap + 0.5) * upt, z);
      }
    }
    job.row = end;
    return end >= n;
  }

  /** Colour, shade and roads over a fully sampled `heights` — a millisecond, so it runs in one go. */
  private finishTile(ter: MapTerrain, job: TileJob): HTMLCanvasElement {
    const { upt, x0, z0, ap, n } = job;
    const canvas = document.createElement("canvas");
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const img = ctx.createImageData(TILE, TILE);
    const data = img.data;
    const sea = ter.waterLevel;
    // Hillshade: slope in world units per unit, lit from the top-left of the page.
    const shadeK = 0.45 / (2 * ap * upt);
    for (let jj = 0; jj < TILE; jj++) {
      for (let ii = 0; ii < TILE; ii++) {
        const at = (jj + ap) * n + ii + ap;
        const y = heights[at];
        let r: number, g: number, bl: number;
        if (y <= sea) {
          // Depth-shaded sea, clamped a few units down so the shelf still reads.
          const d = Math.min(1, (sea - y) / 8);
          r = 26 + (1 - d) * 22;
          g = 74 + (1 - d) * 30;
          bl = 112 + (1 - d) * 34;
        } else {
          const rise = y - sea;
          if (rise < 1.2) {
            // The shore band, sand.
            r = 176;
            g = 160;
            bl = 118;
          } else if (rise < 26) {
            // Grassland, darkening as it climbs.
            const u = rise / 26;
            r = 84 - u * 26;
            g = 128 - u * 34;
            bl = 62 - u * 18;
          } else {
            // Bare rock above the treeline.
            const u = Math.min(1, (rise - 26) / 34);
            r = 96 + u * 52;
            g = 92 + u * 50;
            bl = 84 + u * 50;
          }
          const gx = heights[at + ap] - heights[at - ap];
          const gz = heights[at + ap * n] - heights[at - ap * n];
          const shade = Math.min(1.35, Math.max(0.55, 1 + (gx + gz) * shadeK));
          r *= shade;
          g *= shade;
          bl *= shade;
        }
        const o = (jj * TILE + ii) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // The roads, over the terrain: wayfinding is what a map is FOR. Three world
    // units wide, and never thinner than a texel and a bit when zoomed far out.
    ctx.save();
    ctx.scale(1 / upt, 1 / upt);
    ctx.translate(-x0, -z0);
    ctx.strokeStyle = "rgba(206,182,140,.9)";
    ctx.lineWidth = Math.max(1.2 * upt, 3);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const road of ter.roads()) {
      for (let k = 0; k < road.length; k++) {
        if (k === 0) {
          ctx.moveTo(road[k][0], road[k][1]);
        } else {
          ctx.lineTo(road[k][0], road[k][1]);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
    this.painted++;
    return canvas;
  }

  /** Spend the frame's budget on the tiles the last draw wanted, nearest the centre first, a slice at a time. */
  private paintPending(budget = TILE_BUDGET_MS): void {
    const ter = this.terrain;
    const zm = this.zone;
    if (!ter || !zm) {
      return;
    }
    // A job whose tile the view no longer wants is dropped: a zoom mid-tile must not finish the old level first.
    const job = this.job;
    if (job && !this.pending.some((p) => p.level === job.level && p.i === job.i && p.j === job.j)) {
      this.job = null;
    }
    this.pending.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    let next = 0;
    while (performance.now() - t0 < budget) {
      if (!this.job) {
        while (
          next < this.pending.length &&
          zm.tiles.has(
            tileKey(this.pending[next].level, this.pending[next].i, this.pending[next].j),
          )
        ) {
          next++;
        }
        const p = this.pending[next++];
        if (!p) {
          break;
        }
        this.job = this.startTile(p.level, p.i, p.j);
      }
      if (this.sampleRows(ter, this.job)) {
        zm.tiles.set(
          tileKey(this.job.level, this.job.i, this.job.j),
          this.finishTile(ter, this.job),
        );
        this.job = null;
      }
    }
    this.paintMs += performance.now() - t0;
    this.pending = [];
    // Oldest first, insertion order; the level-0 tile is the fallback for everything and stays.
    for (const key of zm.tiles.keys()) {
      if (zm.tiles.size <= TILE_CACHE_MAX) {
        break;
      }
      if (!key.startsWith("0:")) {
        zm.tiles.delete(key);
      }
    }
  }

  // ---- fog of war -----------------------------------------------------------

  /** Punch a soft hole per explored cell, only for the cells added since last time. */
  private paintFog(zm: ZoneMap, cells: ReadonlySet<number>): void {
    if (cells !== zm.fogSource || cells.size < zm.fogPainted) {
      // Exploration only appends in play; a new set is a restore or session reset and must not inherit old holes.
      zm.fog.clear();
      zm.extent = null;
      zm.fogPainted = 0;
      zm.fogSource = cells;
      zm.seen.clear();
    }
    if (cells.size === zm.fogPainted) {
      return;
    }
    const brush = this.fogBrush ?? (this.fogBrush = makeFogBrush());
    const r = brush.width / 2;
    const rw = r * FOG_TEXEL;
    let k = 0;
    for (const key of cells) {
      if (k++ < zm.fogPainted) {
        continue;
      }
      const [cx, cz] = cellOf(key);
      const wx = (cx + 0.5) * EXPLORE_CELL;
      const wz = (cz + 0.5) * EXPLORE_CELL;
      zm.seen.add(`${Math.floor(wx / SEEN_BLOCK)},${Math.floor(wz / SEEN_BLOCK)}`);
      const e = zm.extent;
      zm.extent = e
        ? {
            minX: Math.min(e.minX, wx),
            minZ: Math.min(e.minZ, wz),
            maxX: Math.max(e.maxX, wx),
            maxZ: Math.max(e.maxZ, wz),
          }
        : { minX: wx, minZ: wz, maxX: wx, maxZ: wz };
      // The brush may straddle a chunk edge: punch it into every sheet it touches, making them as needed.
      for (
        let gz = Math.floor((wz - rw) / FOG_CHUNK);
        gz <= Math.floor((wz + rw) / FOG_CHUNK);
        gz++
      ) {
        for (
          let gx = Math.floor((wx - rw) / FOG_CHUNK);
          gx <= Math.floor((wx + rw) / FOG_CHUNK);
          gx++
        ) {
          const ctx = this.fogChunk(zm, gx, gz);
          ctx.globalCompositeOperation = "destination-out";
          ctx.drawImage(
            brush,
            (wx - gx * FOG_CHUNK) / FOG_TEXEL - r,
            (wz - gz * FOG_CHUNK) / FOG_TEXEL - r,
          );
        }
      }
    }
    zm.fogPainted = cells.size;
  }

  private fogChunk(zm: ZoneMap, gx: number, gz: number): CanvasRenderingContext2D {
    const key = `${gx},${gz}`;
    let c = zm.fog.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = FOG_CHUNK / FOG_TEXEL;
      c.height = FOG_CHUNK / FOG_TEXEL;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = FOG_COLOUR;
      ctx.fillRect(0, 0, c.width, c.height);
      zm.fog.set(key, c);
    }
    return c.getContext("2d") as CanvasRenderingContext2D;
  }

  /** The extent the view may roam: what has been seen, plus sea room, and never smaller than the open span. */
  private bounds(): { minX: number; minZ: number; maxX: number; maxZ: number } {
    const e = this.zone?.extent;
    const p = this.hooks.model().player;
    const half = OPEN_SPAN;
    const b = e
      ? {
          minX: e.minX - EXTENT_MARGIN,
          minZ: e.minZ - EXTENT_MARGIN,
          maxX: e.maxX + EXTENT_MARGIN,
          maxZ: e.maxZ + EXTENT_MARGIN,
        }
      : { minX: p.x - half, minZ: p.z - half, maxX: p.x + half, maxZ: p.z + half };
    return {
      minX: Math.min(b.minX, p.x - half),
      minZ: Math.min(b.minZ, p.z - half),
      maxX: Math.max(b.maxX, p.x + half),
      maxZ: Math.max(b.maxZ, p.z + half),
    };
  }

  // ---- view -----------------------------------------------------------------

  private viewSize(): { w: number; h: number } {
    const c = this.canvas;
    return c ? { w: c.clientWidth, h: c.clientHeight } : { w: 1, h: 1 };
  }

  private resetView(): void {
    if (!this.zone) {
      return;
    }
    // Open on the hero, close enough that the ground round him reads.
    const { w, h } = this.viewSize();
    const p = this.hooks.model().player;
    this.scale = Math.min(w, h) / OPEN_SPAN;
    this.cx = p.x;
    this.cz = p.z;
    this.clampView();
  }

  private clampView(): void {
    if (!this.zone) {
      return;
    }
    const b = this.bounds();
    const { w, h } = this.viewSize();
    // The map COVERS the view at every zoom: the floor is the cover scale of the explored extent, so
    // zooming all the way out shows everything seen so far and no more; the extent grows with the walk.
    this.minScale = Math.min(MAX_SCALE, Math.max(w / (b.maxX - b.minX), h / (b.maxZ - b.minZ)));
    this.scale = Math.min(MAX_SCALE, Math.max(this.minScale, this.scale));
    const hw = w / 2 / this.scale;
    const hh = h / 2 / this.scale;
    // The view may not leave the zone: when it is zoomed out past the bounds it pins to the middle.
    const cxMin = b.minX + hw;
    const cxMax = b.maxX - hw;
    const czMin = b.minZ + hh;
    const czMax = b.maxZ - hh;
    this.cx = cxMin > cxMax ? (b.minX + b.maxX) / 2 : Math.min(cxMax, Math.max(cxMin, this.cx));
    this.cz = czMin > czMax ? (b.minZ + b.maxZ) / 2 : Math.min(czMax, Math.max(czMin, this.cz));
  }

  private toScreen(x: number, z: number): { x: number; y: number } {
    const { w, h } = this.viewSize();
    return { x: w / 2 + (x - this.cx) * this.scale, y: h / 2 + (z - this.cz) * this.scale };
  }

  private toWorld(sx: number, sy: number): { x: number; z: number } {
    const { w, h } = this.viewSize();
    return { x: this.cx + (sx - w / 2) / this.scale, z: this.cz + (sy - h / 2) / this.scale };
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.scale = Math.min(MAX_SCALE, Math.max(this.minScale, this.scale * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
    this.clampView();
  }

  // ---- drawing --------------------------------------------------------------

  private frame = (): void => {
    if (!this.el || !this.canvas || !this.ctx) {
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
    this.frames++;

    // Keyboard pan runs on the frame so a held arrow glides instead of stepping.
    let kx = 0;
    let kz = 0;
    if (this.keysHeld.has("ArrowLeft")) {
      kx -= 1;
    }
    if (this.keysHeld.has("ArrowRight")) {
      kx += 1;
    }
    if (this.keysHeld.has("ArrowUp")) {
      kz -= 1;
    }
    if (this.keysHeld.has("ArrowDown")) {
      kz += 1;
    }
    if (kx !== 0 || kz !== 0) {
      this.cx += (kx * KEY_PAN) / this.scale;
      this.cz += (kz * KEY_PAN) / this.scale;
      this.steering = true;
      this.clampView();
    }

    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.clampView();
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = FOG_COLOUR;
    ctx.fillRect(0, 0, w, h);

    const zm = this.zone;
    const ter = this.terrain;
    if (zm && ter) {
      this.paintFog(zm, ter.explored());
      this.drawTiles(ctx, zm, dpr, w, h);
      // Fog sheets cover explored chunks; an absent sheet is untouched and must cover terrain tiles explicitly.
      const v0 = this.toWorld(0, 0);
      const v1 = this.toWorld(w, h);
      const snap = (v: number): number => Math.round(v * dpr) / dpr;
      ctx.fillStyle = FOG_COLOUR;
      for (let gz = Math.floor(v0.z / FOG_CHUNK); gz <= Math.floor(v1.z / FOG_CHUNK); gz++) {
        for (let gx = Math.floor(v0.x / FOG_CHUNK); gx <= Math.floor(v1.x / FOG_CHUNK); gx++) {
          const sheet = zm.fog.get(`${gx},${gz}`);
          const a = this.toScreen(gx * FOG_CHUNK, gz * FOG_CHUNK);
          const e = this.toScreen((gx + 1) * FOG_CHUNK, (gz + 1) * FOG_CHUNK);
          const x = snap(a.x);
          const y = snap(a.y);
          const width = snap(e.x) - x;
          const height = snap(e.y) - y;
          if (sheet) {
            ctx.drawImage(sheet, x, y, width, height);
          } else {
            ctx.fillRect(x, y, width, height);
          }
        }
      }
    }

    const model = this.hooks.model();
    this.hots = [];

    // Towns he knows of: the settlement's icon under its name.
    ctx.textAlign = "center";
    ctx.font = "700 16px -apple-system,'Segoe UI',Roboto,Arial,sans-serif";
    for (const town of model.towns) {
      if (!town.known) {
        continue;
      }
      const p = this.toScreen(town.x, town.z);
      drawMapIcon(ctx, town.kind === "camp" ? "encampment" : "town", p.x, p.y);
      ctx.fillStyle = "rgba(238,242,248,.92)";
      ctx.strokeStyle = "rgba(0,0,0,.7)";
      ctx.lineWidth = 3;
      ctx.strokeText(town.name, p.x, p.y - MAP_ICON_SIZE / 2 - 4);
      ctx.fillText(town.name, p.x, p.y - MAP_ICON_SIZE / 2 - 4);
    }

    // Waystones: lit ones are travel targets and go into the hit list.
    for (const stone of model.stones) {
      if (!stone.lit) {
        continue;
      }
      const p = this.toScreen(stone.x, stone.z);
      this.hots.push({ kind: "stone", id: stone.id, x: stone.x, z: stone.z });
      drawMapIcon(ctx, "waypoint", p.x, p.y, MAP_ICON_SIZE * 0.85);
    }

    // Quest objectives: the same star the compass chips and world marks use.
    for (const q of model.quests) {
      const p = this.toScreen(q.x, q.z);
      drawMapIcon(ctx, "quest", p.x, p.y);
    }

    // The player marker, a flag.
    if (model.marker) {
      const p = this.toScreen(model.marker.x, model.marker.z);
      this.hots.push({ kind: "marker", id: "player-marker", x: model.marker.x, z: model.marker.z });
      drawMapIcon(ctx, "custom-player-marker", p.x, p.y);
    }

    // The hero: an arrow along his facing. Heading 0 is +Z (atan2(x, z)), which
    // is screen-DOWN here; π − h maps that convention onto canvas rotation.
    {
      const p = this.toScreen(model.player.x, model.player.z);
      drawMapIcon(ctx, "player", p.x, p.y, MAP_ICON_SIZE * 0.9, Math.PI - model.player.facing);
    }

    // Focus ring for keyboard/pad, drawn over whatever holds it.
    const hot = this.hots[this.focus];
    if (hot) {
      const p = this.toScreen(hot.x, hot.z);
      ctx.strokeStyle = "#ffd23f";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, HIT_R, 0, Math.PI * 2);
      ctx.stroke();
    }

    // A centre crosshair while steering without a pointer — it is where Y/P places the marker.
    if (this.steering) {
      ctx.strokeStyle = "rgba(238,242,248,.75)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 10, h / 2);
      ctx.lineTo(w / 2 + 10, h / 2);
      ctx.moveTo(w / 2, h / 2 - 10);
      ctx.lineTo(w / 2, h / 2 + 10);
      ctx.stroke();
    }

    // After the draw, so a slow tile costs the NEXT frame's paint and never this one's input.
    this.paintPending();
  };

  /** Draw the level that puts at least a texel under every device pixel; a missing tile shows its nearest ancestor. */
  private drawTiles(
    ctx: CanvasRenderingContext2D,
    zm: ZoneMap,
    dpr: number,
    w: number,
    h: number,
  ): void {
    const level = levelFor(this.scale, dpr);
    const tw = TILE * uptOf(level);
    const v0 = this.toWorld(0, 0);
    const v1 = this.toWorld(w, h);
    const i0 = Math.floor(v0.x / tw);
    const i1 = Math.floor(v1.x / tw);
    const j0 = Math.floor(v0.z / tw);
    const j1 = Math.floor(v1.z / tw);
    // Tile edges snapped to device pixels: neighbours share an edge exactly, so no seam bleeds through.
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    const edgeX = (i: number): number => snap(this.toScreen(i * tw, 0).x);
    const edgeY = (j: number): number => snap(this.toScreen(0, j * tw).y);
    for (let j = j0; j <= j1; j++) {
      const sy = edgeY(j);
      const sh = edgeY(j + 1) - sy;
      for (let i = i0; i <= i1; i++) {
        const sx = edgeX(i);
        const sw = edgeX(i + 1) - sx;
        const tile = zm.tiles.get(tileKey(level, i, j));
        if (tile) {
          ctx.drawImage(tile, sx, sy, sw, sh);
          continue;
        }
        // Fog is fog: a tile the hero has seen none of is never sampled, and needs no stand-in either.
        if (!this.tileSeen(zm, level, i, j)) {
          continue;
        }
        const dx = (i + 0.5) * tw - this.cx;
        const dz = (j + 0.5) * tw - this.cz;
        this.pending.push({ level, i, j, d: dx * dx + dz * dz });
        // `>>` floors and `&` wraps for negative indices too, so an ancestor west of the origin is the right one.
        for (let up = 1; up <= level; up++) {
          const anc = zm.tiles.get(tileKey(level - up, i >> up, j >> up));
          if (anc) {
            const part = TILE >> up;
            ctx.drawImage(
              anc,
              (i & ((1 << up) - 1)) * part,
              (j & ((1 << up) - 1)) * part,
              part,
              part,
              sx,
              sy,
              sw,
              sh,
            );
            break;
          }
        }
      }
    }
  }

  // ---- interaction ----------------------------------------------------------

  private hotAt(sx: number, sy: number): Hot | null {
    let best: Hot | null = null;
    let bd = HIT_R * HIT_R;
    for (const hot of this.hots) {
      const p = this.toScreen(hot.x, hot.z);
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bd) {
        bd = d;
        best = hot;
      }
    }
    return best;
  }

  private actOn(hot: Hot): void {
    if (hot.kind === "stone") {
      this.askTravel(hot.id);
    } else {
      // The marker: clicking it again picks it back up.
      this.hooks.onMarker(null);
      this.focus = -1;
    }
  }

  /** Place, move or (on the marker itself) remove — the world position given is the truth. */
  private placeAt(x: number, z: number): void {
    const m = this.hooks.model().marker;
    if (m && Math.hypot(m.x - x, m.z - z) * this.scale < HIT_R) {
      this.hooks.onMarker(null);
    } else {
      this.hooks.onMarker({ x, z });
    }
  }

  private askTravel(stoneId: string): void {
    if (!this.el || this.confirmEl) {
      return;
    }
    const box = document.createElement("div");
    box.className = "mconfirm bs-glass";
    box.innerHTML =
      `<p>${escapeHtml(t("map.travel.ask"))}</p>` +
      '<div class="row">' +
      `<button type="button" class="bs-buy" data-go="1"><span>${escapeHtml(t("map.travel.go"))}</span></button>` +
      `<button type="button" class="bs-buy ghost" data-go="0"><span>${escapeHtml(t("map.travel.stay"))}</span></button>` +
      "</div>";
    this.el.querySelector(".pane")?.appendChild(box);
    this.confirmEl = box;
    this.confirmStone = stoneId;
    box.querySelector<HTMLButtonElement>("[data-go='1']")?.focus();
  }

  private dismissConfirm(): void {
    this.confirmEl?.remove();
    this.confirmEl = null;
    this.confirmStone = null;
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || !this.el) {
      return;
    }
    const btn = target.closest("button") as HTMLButtonElement | null;
    if (btn) {
      if (btn.dataset.act === "close") {
        this.close("click");
      } else if (btn.dataset.go !== undefined) {
        const stone = this.confirmStone;
        this.dismissConfirm();
        if (btn.dataset.go === "1" && stone) {
          this.hooks.onTravel(stone);
        }
      }
      return;
    }
    if (target.classList.contains("bs-scrim")) {
      this.close("click");
    }
  };

  private onPointerDown = (ev: PointerEvent): void => {
    if (this.confirmEl) {
      return;
    }
    this.canvas?.setPointerCapture(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    this.dragging = true;
    this.dragMoved = false;
    this.lastX = ev.offsetX;
    this.lastY = ev.offsetY;
    this.steering = false;
    this.updateCursor(ev.offsetX, ev.offsetY);
  };

  /** The canvas declares its cursor: pointer over a travel target, hand for the draggable ground. */
  private updateCursor(sx: number, sy: number): void {
    if (!this.canvas) {
      return;
    }
    const state = this.dragging
      ? "grabbing"
      : this.hotAt(sx, sy)?.kind === "stone"
        ? "link-select"
        : "grab";
    if (this.canvas.dataset.cursor !== state) {
      this.canvas.dataset.cursor = state;
    }
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.dragging || !this.pointers.has(ev.pointerId)) {
      this.updateCursor(ev.offsetX, ev.offsetY);
      return;
    }
    this.pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) {
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinchDist);
      }
      this.pinchDist = d;
      this.dragMoved = true;
      return;
    }
    const dx = ev.offsetX - this.lastX;
    const dy = ev.offsetY - this.lastY;
    if (dx !== 0 || dy !== 0) {
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        this.dragMoved = true;
      }
      this.cx -= dx / this.scale;
      this.cz -= dy / this.scale;
      this.clampView();
      this.lastX = ev.offsetX;
      this.lastY = ev.offsetY;
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    this.pointers.delete(ev.pointerId);
    this.pinchDist = 0;
    if (this.pointers.size > 0) {
      return;
    }
    const wasDrag = this.dragMoved;
    this.dragging = false;
    this.dragMoved = false;
    this.updateCursor(ev.offsetX, ev.offsetY);
    if (wasDrag || this.confirmEl) {
      return;
    }
    // A clean click. The MIDDLE button (or a finger, which has no middle) is the flag: it plants,
    // moves or lifts. The left button only travels — a stray click while panning must not move the flag.
    if (ev.button === 1 || ev.pointerType === "touch") {
      const p = this.toWorld(ev.offsetX, ev.offsetY);
      this.placeAt(p.x, p.z);
      return;
    }
    const hot = this.hotAt(ev.offsetX, ev.offsetY);
    if (hot?.kind === "stone") {
      this.actOn(hot);
    }
  };

  /** The middle button's browser default is autoscroll; the map owns that button. */
  private onMouseDown = (ev: MouseEvent): void => {
    if (ev.button === 1) {
      ev.preventDefault();
    }
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    if (this.confirmEl) {
      return;
    }
    this.zoomAt(ev.offsetX, ev.offsetY, ev.deltaY < 0 ? 1.18 : 1 / 1.18);
    this.steering = false;
  };

  /** Escape and `KeyM` are NOT read here — the host owns those edges for all devices. */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.el || ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    if (this.confirmEl) {
      // Left/right walks the two buttons; Enter is the platform's click.
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const btns = [...this.confirmEl.querySelectorAll<HTMLButtonElement>("button")];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(Math.max(0, i) + 1) % btns.length]?.focus();
        ev.preventDefault();
      }
      return;
    }
    switch (ev.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        this.keysHeld.add(ev.key);
        ev.preventDefault();
        break;
      case "+":
      case "=":
        this.zoomAt(this.viewSize().w / 2, this.viewSize().h / 2, 1.18);
        ev.preventDefault();
        break;
      case "-":
        this.zoomAt(this.viewSize().w / 2, this.viewSize().h / 2, 1 / 1.18);
        ev.preventDefault();
        break;
      case "Tab":
        this.stepFocus(ev.shiftKey ? -1 : 1);
        ev.preventDefault();
        break;
      case "Enter":
        this.activate();
        ev.preventDefault();
        break;
      case "p":
      case "P": {
        const p = this.toWorld(this.viewSize().w / 2, this.viewSize().h / 2);
        this.placeAt(p.x, p.z);
        this.steering = true;
        ev.preventDefault();
        break;
      }
      default:
        break;
    }
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    this.keysHeld.delete(ev.key);
  };

  /** Walk the interactive markers nearest-first from the view centre, wrapping. */
  private stepFocus(dir: number): void {
    if (this.hots.length === 0) {
      this.focus = -1;
      return;
    }
    const order = [...this.hots.keys()].toSorted((a, b) => {
      const ha = this.hots[a];
      const hb = this.hots[b];
      return (
        (ha.x - this.cx) ** 2 +
        (ha.z - this.cz) ** 2 -
        ((hb.x - this.cx) ** 2 + (hb.z - this.cz) ** 2)
      );
    });
    const at = order.indexOf(this.focus);
    const next = order[(at + dir + order.length) % order.length];
    this.focus = next;
    this.steering = true;
    // Bring it into view if it is outside: focus that cannot be seen is not focus.
    const hot = this.hots[this.focus];
    const p = this.toScreen(hot.x, hot.z);
    const { w, h } = this.viewSize();
    if (p.x < 30 || p.x > w - 30 || p.y < 30 || p.y > h - 30) {
      this.cx = hot.x;
      this.cz = hot.z;
      this.clampView();
    }
  }

  /** See `JournalPanel.pollPad` — same edges, this panel's verbs. */
  private pollPad = (): void => {
    if (!this.el) {
      return;
    }
    this.padRaf = requestAnimationFrame(this.pollPad);

    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads?.() ?? []) {
        if (p?.connected) {
          pad = p;
          break;
        }
      }
    } catch {
      return;
    }
    if (!pad) {
      this.padDown.fill(0);
      return;
    }

    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      this.padEdge[i] = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padDown[i] = now;
    }

    if (this.confirmEl) {
      if (this.padEdge[14] || this.padEdge[15]) {
        const btns = [...this.confirmEl.querySelectorAll<HTMLButtonElement>("button")];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(Math.max(0, i) + 1) % btns.length]?.focus();
      }
      if (this.padEdge[0]) {
        this.activate();
      }
      return;
    }

    // Left stick pans; a dead zone keeps a resting stick from creeping the view.
    const ax = pad.axes[0] ?? 0;
    const az = pad.axes[1] ?? 0;
    if (Math.abs(ax) > 0.18 || Math.abs(az) > 0.18) {
      this.cx += (ax * KEY_PAN * 1.4) / this.scale;
      this.cz += (az * KEY_PAN * 1.4) / this.scale;
      this.steering = true;
      this.clampView();
    }
    // Right stick's Y zooms — triggers are gameplay-shaped, sticks are map-shaped.
    const zy = pad.axes[3] ?? 0;
    if (Math.abs(zy) > 0.25) {
      const { w, h } = this.viewSize();
      this.zoomAt(w / 2, h / 2, zy < 0 ? 1.05 : 1 / 1.05);
      this.steering = true;
    }

    // Dpad steps the focus ring; shoulders zoom in steps.
    let step = 0;
    if (this.padEdge[14] || this.padEdge[12]) {
      step = -1;
    } else if (this.padEdge[15] || this.padEdge[13]) {
      step = 1;
    }
    if (step !== 0) {
      this.stepFocus(step);
    }
    if (this.padEdge[4]) {
      const { w, h } = this.viewSize();
      this.zoomAt(w / 2, h / 2, 1 / 1.25);
    }
    if (this.padEdge[5]) {
      const { w, h } = this.viewSize();
      this.zoomAt(w / 2, h / 2, 1.25);
    }
    // A confirms the focused thing; Y drops or lifts the flag at the crosshair.
    if (this.padEdge[0]) {
      this.activate();
    }
    if (this.padEdge[3]) {
      const p = this.toWorld(this.viewSize().w / 2, this.viewSize().h / 2);
      this.placeAt(p.x, p.z);
      this.steering = true;
    }
    // B is NOT read — GamepadControls taps a virtual Escape, routed to `onEscape`.
  };

  private hintHtml(): string {
    const kbd = (s: string): string => `<kbd>${escapeHtml(s)}</kbd>`;
    return (
      `<span>${kbd(t("map.hint.dragKeys"))} ${escapeHtml(t("map.hint.pan"))}</span>` +
      `<span>${kbd(t("map.hint.wheelKeys"))} ${escapeHtml(t("map.hint.zoom"))}</span>` +
      `<span>${kbd(t("map.hint.clickKeys"))} ${escapeHtml(t("map.hint.marker"))}</span>` +
      `<span>${kbd(t("map.hint.stoneKeys"))} ${escapeHtml(t("map.hint.travel"))}</span>`
    );
  }
}
