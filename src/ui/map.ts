import { t } from "../i18n";
import { injectStyles } from "./styles";
import { seedPadButtons } from "../core/gamepad";
import { CLOSE_ICON } from "./icons";

/**
 * Fullscreen world map (issue #245). The panel owns the screen — pan, zoom and
 * focus — and reports every world-changing intent to its host: main.ts decides
 * what a teleport or a placed marker MEANS. It is a modal in the journal's
 * mould: host-owned hotkey (`M`), Escape routed through the host, gamepad via
 * its own pollPad while a panel is up.
 *
 * The map IMAGE is generated like everything else the game draws: terrain
 * height and water sampled into a canvas at panel-open, cached per zone.
 */

export type MapCloseBy = "escape" | "hotkey" | "click" | "travel";

export interface MapTown {
  id: string;
  name: string;
  color: number;
  x: number;
  z: number;
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

/** What the base image is painted from. `roads` are [x, z] polylines. */
export interface MapTerrain {
  zoneId: string;
  heightAt(x: number, z: number): number;
  waterLevel: number;
  roads: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export interface MapHooks {
  model(): MapModel;
  terrain(): MapTerrain;
  /** A confirmed click on a lit stone. The host travels and closes the panel. */
  onTravel(stoneId: string): void;
  /** Place (or move) the one player marker. Null clears it. */
  onMarker(spot: { x: number; z: number } | null): void;
  onOpen?(): void;
  onClose?(by: MapCloseBy): void;
}

/** Base-image resolution cap, px on the long side. ~5 world units per texel on the overworld. */
const IMG_MAX = 640;
/** Pixels of screen the map may zoom a world unit up to. */
const MAX_SCALE = 6;
/** Screen px within which a click hits a marker. Generous — these are travel buttons, not pixels. */
const HIT_R = 26;
/** Keyboard pan speed, world units per frame at scale 1 — divided by scale so it is a screen speed. */
const KEY_PAN = 14;

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

interface BaseImage {
  canvas: HTMLCanvasElement;
  bounds: MapTerrain["bounds"];
}

/** One interactive thing on the map this frame, in world coordinates. */
interface Hot {
  kind: "stone" | "marker";
  id: string;
  x: number;
  z: number;
}

export class MapPanel {
  private el: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** Per-zone base images, kept for the session — terrain does not change under a zone. */
  private readonly cache = new Map<string, BaseImage>();
  private base: BaseImage | null = null;

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
    this.ctx = this.canvas.getContext("2d");

    el.addEventListener("click", this.onClick);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.base = this.baseImage();
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
      view: { cx: +this.cx.toFixed(1), cz: +this.cz.toFixed(1), scale: +this.scale.toFixed(3) },
      confirm: this.confirmStone,
      focus: this.hots[this.focus]?.id ?? null,
      towns: model.towns.length,
      stones: model.stones.length,
      lit: model.stones.filter((s) => s.lit).length,
      quests: model.quests.length,
      marker: model.marker,
      screen: this.isOpen
        ? this.hots.map((h) => {
            const p = this.toScreen(h.x, h.z);
            return { id: h.id, kind: h.kind, x: Math.round(p.x), y: Math.round(p.y) };
          })
        : [],
    };
  }

  // ---- the base image -------------------------------------------------------

  private baseImage(): BaseImage {
    const ter = this.hooks.terrain();
    const hit = this.cache.get(ter.zoneId);
    if (hit) {
      return hit;
    }
    const b = ter.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    const px = Math.max(64, Math.round(w >= h ? IMG_MAX : (IMG_MAX * w) / h));
    const pz = Math.max(64, Math.round(w >= h ? (IMG_MAX * h) / w : IMG_MAX));
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = pz;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const img = ctx.createImageData(px, pz);
    const data = img.data;
    const sea = ter.waterLevel;
    for (let j = 0; j < pz; j++) {
      const z = b.minZ + ((j + 0.5) / pz) * h;
      for (let i = 0; i < px; i++) {
        const x = b.minX + ((i + 0.5) / px) * w;
        const y = ter.heightAt(x, z);
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
        }
        const o = (j * px + i) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // The roads, over the terrain: wayfinding is what a map is FOR.
    ctx.strokeStyle = "rgba(206,182,140,.9)";
    ctx.lineWidth = Math.max(1, px / 320);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const road of ter.roads) {
      if (road.length < 2) {
        continue;
      }
      ctx.beginPath();
      for (let i = 0; i < road.length; i++) {
        const sx = ((road[i][0] - b.minX) / w) * px;
        const sy = ((road[i][1] - b.minZ) / h) * pz;
        if (i === 0) {
          ctx.moveTo(sx, sy);
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.stroke();
    }
    const made = { canvas, bounds: b };
    this.cache.set(ter.zoneId, made);
    return made;
  }

  // ---- view -----------------------------------------------------------------

  private viewSize(): { w: number; h: number } {
    const c = this.canvas;
    return c ? { w: c.clientWidth, h: c.clientHeight } : { w: 1, h: 1 };
  }

  private resetView(): void {
    const b = this.base?.bounds;
    if (!b) {
      return;
    }
    const { w, h } = this.viewSize();
    // Fit the whole zone, then start centred on the hero at a readable zoom.
    this.minScale = Math.min(w / (b.maxX - b.minX), h / (b.maxZ - b.minZ)) * 0.92;
    const p = this.hooks.model().player;
    this.scale = Math.min(MAX_SCALE, Math.max(this.minScale, this.minScale * 2.6));
    this.cx = p.x;
    this.cz = p.z;
    this.clampView();
  }

  private clampView(): void {
    const b = this.base?.bounds;
    if (!b) {
      return;
    }
    this.scale = Math.min(MAX_SCALE, Math.max(this.minScale, this.scale));
    const { w, h } = this.viewSize();
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
    ctx.fillStyle = "#101821";
    ctx.fillRect(0, 0, w, h);

    const base = this.base;
    if (base) {
      const b = base.bounds;
      const tl = this.toScreen(b.minX, b.minZ);
      ctx.drawImage(
        base.canvas,
        tl.x,
        tl.y,
        (b.maxX - b.minX) * this.scale,
        (b.maxZ - b.minZ) * this.scale,
      );
    }

    const model = this.hooks.model();
    this.hots = [];

    // Towns: a labelled dot in the town's own colour.
    ctx.textAlign = "center";
    for (const town of model.towns) {
      const p = this.toScreen(town.x, town.z);
      ctx.fillStyle = hex(town.color);
      ctx.strokeStyle = "rgba(0,0,0,.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = "700 16px -apple-system,'Segoe UI',Roboto,Arial,sans-serif";
      ctx.fillStyle = "rgba(238,242,248,.92)";
      ctx.strokeStyle = "rgba(0,0,0,.7)";
      ctx.lineWidth = 3;
      ctx.strokeText(town.name, p.x, p.y - 11);
      ctx.fillText(town.name, p.x, p.y - 11);
    }

    // Waystones: lit ones are travel targets and go into the hit list.
    for (const stone of model.stones) {
      if (!stone.lit) {
        continue;
      }
      const p = this.toScreen(stone.x, stone.z);
      this.hots.push({ kind: "stone", id: stone.id, x: stone.x, z: stone.z });
      ctx.fillStyle = "#8be3ff";
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      // A standing stone: a slim diamond.
      ctx.moveTo(p.x, p.y - 8);
      ctx.lineTo(p.x + 5, p.y);
      ctx.lineTo(p.x, p.y + 8);
      ctx.lineTo(p.x - 5, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Quest objectives: the same gold the compass chips and world marks use.
    for (const q of model.quests) {
      const p = this.toScreen(q.x, q.z);
      this.star(ctx, p.x, p.y, 9, "#ffc44d");
    }

    // The player marker, a flag.
    if (model.marker) {
      const p = this.toScreen(model.marker.x, model.marker.z);
      this.hots.push({ kind: "marker", id: "player-marker", x: model.marker.x, z: model.marker.z });
      ctx.strokeStyle = "#eef2f8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - 14);
      ctx.stroke();
      ctx.fillStyle = "#ff5d5d";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 14);
      ctx.lineTo(p.x + 10, p.y - 10);
      ctx.lineTo(p.x, p.y - 6);
      ctx.closePath();
      ctx.fill();
    }

    // The hero: an arrow along his facing. Heading 0 is +Z (atan2(x, z)), which
    // is screen-DOWN here; π − h maps that convention onto canvas rotation.
    {
      const p = this.toScreen(model.player.x, model.player.z);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI - model.player.facing);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Focus ring for keyboard/pad, drawn over whatever holds it.
    const hot = this.hots[this.focus];
    if (hot) {
      const p = this.toScreen(hot.x, hot.z);
      ctx.strokeStyle = "#ffd23f";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
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
  };

  private star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.45;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
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
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.dragging || !this.pointers.has(ev.pointerId)) {
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
    if (wasDrag || this.confirmEl) {
      return;
    }
    // A clean click: a lit stone asks to travel, the marker lifts, bare ground takes the flag.
    const hot = this.hotAt(ev.offsetX, ev.offsetY);
    if (hot) {
      this.actOn(hot);
    } else {
      const p = this.toWorld(ev.offsetX, ev.offsetY);
      this.placeAt(p.x, p.z);
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
