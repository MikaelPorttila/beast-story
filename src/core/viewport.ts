/**
 * The visible viewport, measured and published as `--bs-vw` / `--bs-vh` / `--bs-vmin`.
 *
 * `100dvh` can stay stale after a fullscreen transition — Android/Brave resolved it
 * 110 px taller than the display and pushed the touch fan off-screen (issue #16). So
 * take the SMALLEST of innerHeight, clientHeight and (coarse pointer + fullscreen only)
 * screen.height: every failure in this class is an overhang. CSS keeps `100dvh` as its
 * fallback for first paint.
 */

import { isTouchPrimary } from './touch';
import { isFullscreen } from '../ui/fullscreen';

const VAR_W = '--bs-vw';
const VAR_H = '--bs-vh';
const VAR_MIN = '--bs-vmin';

/** Re-measure delays (ms): Chrome and WebKit report pre-transition metrics for some frames. */
const SETTLE_MS = [60, 180, 400, 900];

export interface ViewportSize {
  /** CSS px. */
  w: number;
  h: number;
}

let current: ViewportSize = { w: 0, h: 0 };
let installed = false;
const timers: ReturnType<typeof setTimeout>[] = [];

/** `{0,0}` before `installViewport()` has run. */
export function viewportSize(): ViewportSize {
  return current;
}

/** Reads the DOM, writes nothing. */
export function measureViewport(): ViewportSize {
  const doc = document.documentElement;
  const iw = window.innerWidth || 0;
  const ih = window.innerHeight || 0;
  const cw = doc?.clientWidth || 0;
  const ch = doc?.clientHeight || 0;

  // Orientation from the viewport, never `screen` — not every browser swaps its axes.
  const landscape = (iw || cw) >= (ih || ch);
  const s = window.screen;
  const capped = isTouchPrimary() && isFullscreen();
  const sw = capped ? s?.width || 0 : 0;
  const sh = capped ? s?.height || 0 : 0;
  const long = Math.max(sw, sh) || Infinity;
  const short = Math.min(sw, sh) || Infinity;

  const w = smallest(iw, cw, landscape ? long : short);
  const h = smallest(ih, ch, landscape ? short : long);
  // Floor, not round: half a pixel of overhang is still overhang.
  return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
}

/** Smallest candidate that reported anything at all. */
function smallest(...candidates: number[]): number {
  let best = Infinity;
  for (const c of candidates) if (c > 0 && c < best) best = c;
  return Number.isFinite(best) ? best : 1;
}

function apply(): void {
  const v = measureViewport();
  if (v.w === current.w && v.h === current.h) return;
  current = v;
  const style = document.documentElement.style;
  style.setProperty(VAR_W, `${v.w}px`);
  style.setProperty(VAR_H, `${v.h}px`);
  style.setProperty(VAR_MIN, `${Math.min(v.w, v.h)}px`);
}

function applyAndSettle(): void {
  apply();
  while (timers.length) clearTimeout(timers.pop()!);
  for (const ms of SETTLE_MS) timers.push(setTimeout(apply, ms));
}

/** Idempotent. Call BEFORE the engine: `#app` is sized from these properties. */
export function installViewport(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  apply();
  window.addEventListener('resize', applyAndSettle);
  window.addEventListener('orientationchange', applyAndSettle);
  document.addEventListener('fullscreenchange', applyAndSettle);
  // Prefixed spelling, for WebKit.
  document.addEventListener('webkitfullscreenchange', applyAndSettle);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', applyAndSettle);
  vv?.addEventListener('scroll', apply);

  // Registered here, not main.ts: these layers are up before the world is.
  (window as unknown as { __dbgViewport: () => unknown }).__dbgViewport = () => ({
    ...current,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    clientW: document.documentElement.clientWidth,
    clientH: document.documentElement.clientHeight,
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
    dpr: window.devicePixelRatio,
    fullscreen: isFullscreen(),
    touchPrimary: isTouchPrimary(),
  });
}
