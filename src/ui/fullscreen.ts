/**
 * Fullscreen: the feature detect, and the one call that enters it.
 *
 * GESTURE RULE: `requestFullscreen()` only counts inside a user activation, so
 * the one legal call site is the New Game handler's FIRST statement, before any
 * await (see `StartMenu.start`). A gamepad press is not an activation.
 *
 * ESCAPE is both the in-game menu key and the browser's leave-fullscreen key,
 * which `preventDefault` cannot reach. `navigator.keyboard.lock(['Escape'])`
 * claims it (Chromium, secure context, top-level only) and is why
 * `Input.CAPTURED` lists Escape; the lock is scoped to the fullscreen SESSION, so
 * `installEscapeLock()` re-takes it on every `fullscreenchange`. Missing, the game
 * declines fullscreen entirely (issue #83) — it would die at the first panel close.
 */
import { isTouchPrimary } from '../core/touch';

/** The prefixed half of the API, as on Safari/older WebKit. */
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
/** Keyboard Lock, which lib.dom does not declare. */
type KeyboardLock = {
  lock: (codes?: string[]) => Promise<void>;
  unlock: () => void;
};
type LockNavigator = Navigator & { keyboard?: KeyboardLock };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Can this browser go fullscreen? `!== false` — the flag may be undefined. */
export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as FsElement;
  const doc = document as FsDocument;
  if (typeof el.requestFullscreen === 'function') return doc.fullscreenEnabled !== false;
  if (typeof el.webkitRequestFullscreen === 'function') return doc.webkitFullscreenEnabled !== false;
  return false;
}

/** Currently fullscreen, by either spelling. */
export function isFullscreen(): boolean {
  const doc = document as FsDocument;
  return !!(document.fullscreenElement ?? doc.webkitFullscreenElement ?? null);
}

/** Intent, NOT cleared when the browser leaves on its own — the menu restores from it. */
let wanted = false;
export function fullscreenWanted(): boolean { return wanted; }

/** Ask for fullscreen. Call ONLY from inside a user-gesture handler, first. */
export function enterFullscreen(): boolean {
  if (!fullscreenSupported()) return false;
  // Recorded before the early return — see `fullscreenWanted`.
  wanted = true;
  if (isFullscreen()) return false;
  const el = document.documentElement as FsElement;
  const req = typeof el.requestFullscreen === 'function'
    ? el.requestFullscreen({ navigationUI: 'hide' })
    : el.webkitRequestFullscreen?.();
  void Promise.resolve(req).catch(() => {});
  return true;
}

/** Give the screen back. Under NO gesture deadline, unlike `enterFullscreen`. */
export function exitFullscreen(): boolean {
  wanted = false;
  if (!isFullscreen()) return false;
  const doc = document as FsDocument;
  const req = typeof document.exitFullscreen === 'function'
    ? document.exitFullscreen()
    : doc.webkitExitFullscreen?.();
  void Promise.resolve(req).catch(() => {});
  return true;
}

/** The lock object, or null where the API is missing or the context forbids it. */
function keyboard(): KeyboardLock | null {
  if (typeof navigator === 'undefined') return null;
  const kb = (navigator as LockNavigator).keyboard;
  if (!kb || typeof kb.lock !== 'function' || typeof kb.unlock !== 'function') return null;
  // Chromium exposes the object over plain http and rejects the call.
  if (typeof isSecureContext === 'boolean' && !isSecureContext) return null;
  return kb;
}

/** Chromium, secure context. */
export function keyboardLockSupported(): boolean { return keyboard() !== null; }

/**
 * Would a fullscreen survive the player pressing Escape (issue #83)? Yes if the
 * lock holds the key, or the device is touch-primary and has no Escape key.
 */
export function fullscreenSurvivesEscape(): boolean {
  return keyboardLockSupported() || isTouchPrimary();
}

/** Whether the last lock attempt was GRANTED. Probes assert here, not on intent. */
let escapeLocked = false;
export function escapeIsLocked(): boolean { return escapeLocked; }

/** Take Escape, if this browser lets us. A second `lock()` replaces the first. */
function lockEscape(): void {
  const kb = keyboard();
  if (!kb) return;
  kb.lock(['Escape']).then(
    () => { escapeLocked = true; },
    () => { escapeLocked = false; },
  );
}

/** Give every key back. Idempotent. */
function unlockKeys(): void {
  const kb = keyboard();
  if (!kb) return;
  escapeLocked = false;
  try { kb.unlock(); } catch { /* nothing holds a lock; not worth an error */ }
}

let installed = false;

/**
 * Arm the lock for the life of the page. Call once, at boot — `keyboard.lock()`
 * needs no user activation, so it can be driven off the change event.
 */
export function installEscapeLock(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const sync = () => { if (isFullscreen()) lockEscape(); else unlockKeys(); };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  // A page can be fullscreen already (a reload keeps it), so do not wait for an edge.
  if (isFullscreen()) lockEscape();
}
