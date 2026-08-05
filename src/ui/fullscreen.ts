/**
 * Fullscreen: the feature detect, and the one call that enters it.
 *
 * WHAT THIS USED TO BE. A "Play fullscreen?" pill — first raised over the live
 * game on touch devices, then promoted to a step of the title screen, asked on
 * every device and every launch. It is gone, and the argument for removing it is
 * the same one that had already been made twice for making it appear less: the
 * question was never the interesting part. Someone who wants fullscreen wants it
 * every time; someone who does not wants to be left alone. Doing it on New Game
 * and putting a switch in Settings says exactly that, and costs nobody a tap.
 *
 * THE GESTURE RULE, which is why this is a function and not a system.
 *
 * `Element.requestFullscreen()` only counts when the browser can attribute it to
 * a user activation. There is therefore exactly one place it may be called from
 * — inside the handler for the click or keypress on New Game, as the FIRST thing
 * that handler does, before any await, timer or transition. Not from a frame
 * loop, not from a promise continuation, not on load. See `StartMenu.start`.
 *
 * A GAMEPAD press is not a user activation in any browser, so a player who
 * starts the game from a controller stays windowed however the setting is set.
 * That is a browser rule and not something this code can route around; the
 * failure is silent and the game is entirely playable in a window.
 *
 * WHERE IT CANNOT HAPPEN AT ALL. iOS Safari on iPhone has no element-level
 * Fullscreen API — no `requestFullscreen`, no `webkitRequestFullscreen` on an
 * element, only `<video>.webkitEnterFullscreen`. `fullscreenSupported()`
 * feature-detects both spellings plus the `*fullscreenEnabled` flag (which is
 * how an iframe or a permissions policy says "the method is there and you may
 * not use it"), and `enterFullscreen` simply does nothing where the answer is no.
 *
 * ESCAPE IS THE GAME'S KEY, AND TAKING IT NEEDS A SECOND API.
 *
 * Escape opens the in-game menu (ui/pause.ts) and it is also the browser's own
 * "leave fullscreen" key. `preventDefault` does NOT reach that half — the exit
 * is a user-agent action taken before the page has a say — so for as long as
 * this file was only the Fullscreen API, one press did both: the menu came up
 * AND the screen shrank, having been asked for neither. `PauseMenu.close` puts
 * fullscreen back where it can, which is a patch over the symptom and only
 * works when the menu is dismissed by a CLICK (see the note there).
 *
 * The Keyboard Lock API is the part that actually says "this key is mine".
 * `navigator.keyboard.lock(['Escape'])` routes Escape to the page while the
 * document is fullscreen, INCLUDING the press that would otherwise have exited
 * it, and it makes `preventDefault` on that keydown mean something — which is
 * why `Input.CAPTURED` lists Escape. The browser keeps one escape hatch that no
 * page may close: press and HOLD Escape for about a second and it leaves
 * fullscreen anyway, showing its own "press and hold" notice. That is a
 * deliberate anti-trap rule in the spec, not a gap in this code.
 *
 * WHERE IT CANNOT HAPPEN. Keyboard lock is Chromium-only today (Chrome, Edge,
 * Brave, Opera), needs a SECURE CONTEXT — https or localhost, so the dev server
 * qualifies and a plain-http LAN test does not — and only applies to a top-level
 * document, so the game in an iframe keeps the old behaviour. Everywhere it is
 * missing, nothing here throws and nothing changes: Escape still opens the menu,
 * still drops fullscreen, and `PauseMenu.close` still tries to put it back.
 *
 * IT IS ARMED ON EVERY ENTRY, not once at boot. The lock is scoped to the
 * fullscreen session — a document that leaves fullscreen has no lock afterwards
 * — so `installEscapeLock()` re-takes it from a `fullscreenchange` listener and
 * releases it on the way out, rather than relying on one call at start-up
 * surviving a player who alt-tabs, F11s or press-and-holds their way out.
 *
 * AND WHERE THE LOCK IS MISSING, THE GAME NO LONGER TAKES THE SCREEN. Issue #83:
 * Escape is how a player closes a panel, so on Firefox and Safari a fullscreen
 * taken at New Game survives exactly until the first inventory is shut. The
 * restore in `PauseMenu.close` cannot cover that — it needs a fresh activation,
 * which a keypress on a dead fullscreen is not — so the honest answer is not to
 * enter one that is going to be torn away. `fullscreenSurvivesEscape()` is that
 * question, and `StartMenu.start` and the settings row are its two readers.
 */
import { isTouchPrimary } from '../core/touch';

/** The prefixed half of the API, as it exists on Safari/older WebKit. */
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
/**
 * Keyboard Lock, which lib.dom does not declare. Only the two methods are named
 * — `getLayoutMap` is on the real interface and nothing here wants it.
 */
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

/**
 * True when this browser can actually put the page fullscreen.
 *
 * The method check is the important half (iPhone Safari fails it outright); the
 * `*fullscreenEnabled` check catches the case where the method exists but the
 * embedding context forbids it, and is written as `!== false` so a browser that
 * never defined the flag is not disqualified by it.
 */
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

/**
 * Does the GAME mean to be fullscreen right now?
 *
 * Set by `enterFullscreen`, cleared by `exitFullscreen`, and deliberately NOT
 * cleared by the browser leaving fullscreen on its own — which is the whole
 * point. Where there is no keyboard lock, Escape drops fullscreen before the
 * page has any say, so `isFullscreen()` sampled when the menu opens says "no"
 * and the state the player actually chose is lost. The intent survives it, and
 * the menu restores from the intent on its way out.
 */
let wanted = false;
export function fullscreenWanted(): boolean { return wanted; }

/**
 * Ask for fullscreen. Call ONLY from inside a user-gesture handler, first.
 *
 * Returns whether a request was actually issued — false where the API is
 * missing or the page is already fullscreen — which is for probes to assert on,
 * not for the game to branch on. A rejection is swallowed: the user agent
 * refusing, or the activation having gone stale, leaves the game windowed, and
 * that is not worth an error dialog. Swallowing it also keeps it out of the
 * console as an unhandled rejection.
 */
export function enterFullscreen(): boolean {
  if (!fullscreenSupported()) return false;
  // INTENT, recorded before the early return and kept whatever the browser
  // answers. It is what lets the in-game menu put back a fullscreen the browser
  // took rather than one the game gave up — see `fullscreenWanted`.
  wanted = true;
  if (isFullscreen()) return false;
  const el = document.documentElement as FsElement;
  const req = typeof el.requestFullscreen === 'function'
    ? el.requestFullscreen({ navigationUI: 'hide' })
    : el.webkitRequestFullscreen?.();
  void Promise.resolve(req).catch(() => {});
  return true;
}

/**
 * Give the screen back. Returns whether a request was issued.
 *
 * The mirror of `enterFullscreen` and, unlike it, under NO gesture deadline —
 * leaving fullscreen has never needed a user activation, which is what lets the
 * in-game menu's Exit call it from a click handler several frames deep.
 *
 * Exit is the only caller, and the reason it is a caller at all is that
 * fullscreen is a thing the game TOOK (see the note in ui/menu.ts): a player
 * going back to the title screen is asking for the state they were in before
 * they pressed New Game, and the browser has no reason to undo that by itself.
 * A rejection is swallowed for the same reason as above — a page that stays
 * fullscreen is not worth an error, and the player still has Escape.
 */
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

// ---------------------------------------------------------------------------
// Keyboard lock — Escape belongs to the game. See the header.
// ---------------------------------------------------------------------------

/** The lock object, or null where the API is missing or the context forbids it. */
function keyboard(): KeyboardLock | null {
  if (typeof navigator === 'undefined') return null;
  const kb = (navigator as LockNavigator).keyboard;
  if (!kb || typeof kb.lock !== 'function' || typeof kb.unlock !== 'function') return null;
  // A SECURE CONTEXT ONLY. Chromium exposes the object either way and rejects
  // the call over plain http; asking here keeps the rejection out of the console
  // and makes `keyboardLockSupported()` an honest answer for the probe.
  if (typeof isSecureContext === 'boolean' && !isSecureContext) return null;
  return kb;
}

/** True where `lock()` can actually be called. Chromium, secure context. */
export function keyboardLockSupported(): boolean { return keyboard() !== null; }

/**
 * Would a fullscreen the game takes still be there after the player presses
 * Escape? Issue #83.
 *
 * Two ways to answer yes, and they are the two ways Escape can fail to reach the
 * browser. The keyboard lock takes the key (see the header). A TOUCH-PRIMARY
 * device has no Escape key at all — a phone closes a panel with the touch
 * overlay's MENU button, which taps a VIRTUAL Escape the browser never sees —
 * and it is also where fullscreen is worth the most, since it is what hides the
 * URL bar. Everywhere else the answer is no: one press of Escape drops the
 * screen before the page has a say, and no amount of restoring puts it back.
 *
 * This asks whether the ESCAPE KEY can be held, not whether fullscreen exists at
 * all — `enterFullscreen` already no-ops where the API is missing, and folding
 * the two questions together would put an iPhone's "no Fullscreen API" behind a
 * note about a key it does not have.
 */
export function fullscreenSurvivesEscape(): boolean {
  return keyboardLockSupported() || isTouchPrimary();
}

/**
 * Whether the last lock attempt was GRANTED — the browser's answer, not ours.
 *
 * Kept beside the request because the two can disagree for reasons this code
 * cannot see (an iframe, an enterprise policy), and a probe asserting on intent
 * would pass in exactly the cases the feature is broken in.
 */
let escapeLocked = false;
export function escapeIsLocked(): boolean { return escapeLocked; }

/**
 * Take Escape, if this browser lets us. Safe to call when already held — a
 * second `lock()` replaces the first rather than stacking.
 */
function lockEscape(): void {
  const kb = keyboard();
  if (!kb) return;
  kb.lock(['Escape']).then(
    () => { escapeLocked = true; },
    () => { escapeLocked = false; },
  );
}

/** Give every key back. Called on the way out of fullscreen, and idempotent. */
function unlockKeys(): void {
  const kb = keyboard();
  if (!kb) return;
  escapeLocked = false;
  try { kb.unlock(); } catch { /* nothing holds a lock; not worth an error */ }
}

let installed = false;

/**
 * Arm the lock for the life of the page: taken on entering fullscreen, released
 * on leaving it.
 *
 * Call once, at boot. It is NOT a user-gesture call — unlike
 * `requestFullscreen`, `keyboard.lock()` has no activation requirement, which is
 * what lets it be driven off the change event rather than wedged into the New
 * Game handler beside the fullscreen request.
 *
 * Both spellings of the event are listened for, because the browsers that use
 * the `webkit` one are exactly the browsers where `keyboard()` returns null —
 * the listener is then a no-op, and this file stays free of a second feature
 * test that would have to be kept in step with the first.
 */
export function installEscapeLock(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const sync = () => { if (isFullscreen()) lockEscape(); else unlockKeys(); };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  // A page can be fullscreen already — a reload inside fullscreen keeps it, and
  // a run can be launched into one — so do not wait for an edge. Only the LOCK
  // half: an unlock at boot would be a call about a lock nobody has taken.
  if (isFullscreen()) lockEscape();
}
