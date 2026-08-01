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
 */

/** The prefixed half of the API, as it exists on Safari/older WebKit. */
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
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
  if (!fullscreenSupported() || isFullscreen()) return false;
  const el = document.documentElement as FsElement;
  const req = typeof el.requestFullscreen === 'function'
    ? el.requestFullscreen({ navigationUI: 'hide' })
    : el.webkitRequestFullscreen?.();
  void Promise.resolve(req).catch(() => {});
  return true;
}
