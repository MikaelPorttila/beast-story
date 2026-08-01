/**
 * THE VISIBLE VIEWPORT, MEASURED — the one box every full-screen layer is cut
 * from, published as two CSS custom properties on `:root`:
 *
 *   --bs-vw / --bs-vh   the width and height of what the player can actually see
 *   --bs-vmin           the shorter of the two, which the touch overlay's whole
 *                       geometry is a fraction of (see core/touch.ts)
 *
 * WHY THIS EXISTS, i.e. why `100dvh` is not the answer it looks like.
 *
 * The dynamic viewport units are the right IDEA — `dvh` is the one length that
 * follows a mobile URL bar sliding away — and they were what the game's three
 * full-screen layers were sized in: `#app` (which the canvas and therefore the
 * camera aspect follow), `.bs-touch` and `.bs-root`. Then issue #16 arrived with
 * a Brave/Android screenshot of a Samsung S22 in which the twin sticks and JUMP
 * were simply not on the screen, and the whole button fan had slid off the
 * bottom edge.
 *
 * Fitting the fan's own geometry (every button's angle and radius is fixed by
 * the stylesheet in core/touch.ts) to the four button centres visible in that
 * screenshot says exactly what happened. The device is 1080x2340 device px at
 * DPR 2.8125, so 384x832 CSS px; the three unclipped buttons put the overlay's
 * bottom edge at 941.6, 941.6 and 941.7 CSS px. So on entering fullscreen the
 * browser resolved `100dvh` to 941.6 px — not merely a stale viewport, but 110
 * px MORE THAN THE PHYSICAL DISPLAY HAS, which is roughly the status bar, the
 * URL bar and the gesture bar the fullscreen transition had just removed added
 * back on. Nothing re-resolved it, because nothing in a CSS-unit layout re-asks;
 * rotating the phone to landscape and back forced the browser to recompute and
 * the controls snapped home, which is what the reporter found and is the clue
 * that this is a stale RESOLUTION rather than a wrong stylesheet.
 *
 * So the size is measured here instead, from three numbers that come from
 * different plumbing than the CSS units, and the SMALLEST is used:
 *
 *   window.innerHeight              the visual viewport — tracks the URL bar
 *   documentElement.clientHeight    the layout viewport — excludes scrollbars
 *   screen.height                   the display, in fullscreen only (see below)
 *
 * Smallest, because every failure in this class is an overhang: a layer larger
 * than the visible box puts controls where no thumb can reach them, while one
 * that is slightly small merely floats them a few pixels in from the edge.
 *
 * THE SCREEN IS THE LAST WORD, AND ONLY ON A PHONE IN FULLSCREEN. A fullscreen
 * page covers the display and can therefore not be taller than it, which makes
 * `screen` a hard bound there and a wrong one everywhere else:
 *   - windowed, the browser's own chrome is what the page is missing, and
 *     `innerHeight` already reports it;
 *   - on a desktop, `screen.*` and `innerHeight` legitimately disagree by the
 *     page zoom factor — zoom to 50% and `innerHeight` doubles while the display
 *     does not — so capping would shrink the game for anyone zoomed out.
 * Coarse pointer AND fullscreen is the S22 case and nothing else. It is also the
 * only branch that would have caught 941.6 on that phone, since a browser that
 * has mis-resolved its viewport may well report the same wrong number through
 * `innerHeight`, and it is guarded by tools/test-viewport.mjs.
 *
 * WHEN IT RE-MEASURES. On `resize`, on `visualViewport` resize/scroll (which is
 * where a URL bar collapse reports), on `orientationchange`, and on
 * `fullscreenchange` in both spellings — plus a short SETTLE SWEEP after each,
 * because Android reports stale metrics through a transition it is still
 * animating (engine.ts already waits 120 ms after an orientation flip for the
 * same reason). The sweep is four timers and a comparison; it writes nothing
 * when the numbers have not moved, so it costs no layout.
 *
 * The CSS keeps `100dvh` as its fallback — `var(--bs-vh, 100dvh)` — so the first
 * paint, and any page where this module never runs, behave exactly as before.
 */

import { isTouchPrimary } from './touch';
import { isFullscreen } from '../ui/fullscreen';

/** The custom properties every full-screen layer is sized from. */
const VAR_W = '--bs-vw';
const VAR_H = '--bs-vh';
const VAR_MIN = '--bs-vmin';

/**
 * Re-measure at these delays (ms) after any viewport event. A fullscreen or
 * orientation transition is animated, and both Chrome and WebKit answer with
 * pre-transition metrics for several frames into it.
 */
const SETTLE_MS = [60, 180, 400, 900];

export interface ViewportSize {
  /** CSS px of visible width. */
  w: number;
  /** CSS px of visible height. */
  h: number;
}

let current: ViewportSize = { w: 0, h: 0 };
let installed = false;
const timers: ReturnType<typeof setTimeout>[] = [];

/** The last measured visible box. `{0,0}` before `installViewport()` has run. */
export function viewportSize(): ViewportSize {
  return current;
}

/**
 * Measure the visible box. Pure — reads the DOM, writes nothing — so a probe or
 * a caller that wants the truth right now can ask without side effects.
 */
export function measureViewport(): ViewportSize {
  const doc = document.documentElement;
  const iw = window.innerWidth || 0;
  const ih = window.innerHeight || 0;
  const cw = doc?.clientWidth || 0;
  const ch = doc?.clientHeight || 0;

  // Orientation comes from the viewport itself, never from `screen`: not every
  // browser swaps `screen.width`/`height` when the device turns, and a cap
  // applied to the wrong axis would halve the overlay rather than trim it.
  const landscape = (iw || cw) >= (ih || ch);
  const s = window.screen;
  const capped = isTouchPrimary() && isFullscreen();
  const sw = capped ? s?.width || 0 : 0;
  const sh = capped ? s?.height || 0 : 0;
  const long = Math.max(sw, sh) || Infinity;
  const short = Math.min(sw, sh) || Infinity;

  const w = smallest(iw, cw, landscape ? long : short);
  const h = smallest(ih, ch, landscape ? short : long);
  // Floor rather than round: half a pixel of overhang is still overhang, and
  // half a pixel of inset is invisible.
  return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
}

/** Smallest of the candidates that reported anything at all. */
function smallest(...candidates: number[]): number {
  let best = Infinity;
  for (const c of candidates) if (c > 0 && c < best) best = c;
  return Number.isFinite(best) ? best : 1;
}

/** Measure and publish, if anything moved. */
function apply(): void {
  const v = measureViewport();
  if (v.w === current.w && v.h === current.h) return;
  current = v;
  const style = document.documentElement.style;
  style.setProperty(VAR_W, `${v.w}px`);
  style.setProperty(VAR_H, `${v.h}px`);
  style.setProperty(VAR_MIN, `${Math.min(v.w, v.h)}px`);
}

/** Apply now, then again as the transition that triggered this settles. */
function applyAndSettle(): void {
  apply();
  while (timers.length) clearTimeout(timers.pop()!);
  for (const ms of SETTLE_MS) timers.push(setTimeout(apply, ms));
}

/**
 * Start measuring. Idempotent, and safe to call before anything else exists —
 * it only touches `document.documentElement`.
 *
 * Call it BEFORE the engine is constructed: `#app` is sized from these
 * properties and the renderer takes its first size from that element.
 */
export function installViewport(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  apply();
  window.addEventListener('resize', applyAndSettle);
  window.addEventListener('orientationchange', applyAndSettle);
  document.addEventListener('fullscreenchange', applyAndSettle);
  // The prefixed spelling, for the same WebKit that needs it in ui/fullscreen.ts.
  document.addEventListener('webkitfullscreenchange', applyAndSettle);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', applyAndSettle);
  vv?.addEventListener('scroll', apply);

  // Read-only probe, registered here rather than in main.ts because the layers
  // this sizes are up before the world is — the title screen is a full-screen
  // layer too. Reports every number the decision was made from, so a bug report
  // from a phone can be diagnosed the way issue #16 had to be, from a photo.
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
