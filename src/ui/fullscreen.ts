import { isTouchPrimary } from '../core/touch';
import { injectStyles } from './styles';

/**
 * "Play fullscreen?" — a two-button pill, touch devices only.
 *
 * WHY IT IS A SEPARATE OVERLAY AND NOT A HUD CHILD
 *
 * `.cp-root` is `z-index:20`, which makes it a stacking context, so a child of
 * it can never hit-test above the touch overlay at `z-index:30` — and the pill
 * has to sit over the corner the transparent look pad owns. So this is a
 * body-level sibling at `z-index:40`, built and removed by this module alone.
 * Its CSS still lives in `ui/styles.ts` with the rest of the HUD sheet
 * (`cp-fsprompt` / `cp-fs-btn`), and it follows the same rule everything else
 * there follows: the interactive element opts INTO pointer events, nothing else
 * does, and dismissing it deletes the node — there is no invisible wrapper left
 * over the play area to eat a drag.
 *
 * THE GESTURE RULE
 *
 * `Element.requestFullscreen()` only counts when the browser can attribute it to
 * a user activation. It is therefore called as the FIRST statement of the YES
 * button's own click handler — not deferred to a frame-loop flag, not chained
 * onto a promise that lands a tick later, not fired from a timer. Everything
 * that is not the request itself (remembering the answer, tearing the DOM down)
 * happens after the call has already been made.
 *
 * WHERE IT DOES NOT APPEAR
 *
 * iOS Safari on iPhone has no element-level Fullscreen API at all — no
 * `requestFullscreen`, no `webkitRequestFullscreen` on an element, only
 * `<video>.webkitEnterFullscreen`. A prompt whose YES silently does nothing is
 * worse than no prompt, so `supported()` feature-detects both the standard and
 * the webkit-prefixed entry points (plus the `*fullscreenEnabled` flag, which is
 * how an iframe or a policy says "the method exists but is forbidden") and the
 * prompt is simply never built where the answer could not be honoured.
 *
 * PERSISTENCE — see `readAnswer`.
 */

/** localStorage key. Namespaced so a later save system can share the prefix. */
const STORAGE_KEY = 'cp:fullscreen-prompt';

type Answer = 'yes' | 'no';

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
 * The stored answer, or null if never asked.
 *
 * BOTH answers are sticky and both suppress the prompt forever after.
 *
 * "No" obviously has to stick or it nags on every load. "Yes" sticks for the
 * same reason: the answer CANNOT be replayed automatically — entering
 * fullscreen needs a gesture and a page load is not one — so re-asking a player
 * who already said yes is the identical nag with a nicer story attached, and
 * quietly grabbing fullscreen off their first ATK tap instead would fire in the
 * middle of gameplay and read as a bug. So a "yes" session that ends (or a
 * system swipe out of fullscreen) simply leaves the game windowed, and
 * `?fsprompt=1` is the documented way back — the same URL-override culture the
 * post-processing knobs already use.
 *
 * localStorage throws in some private-browsing modes; a failure degrades to
 * "never asked", i.e. the prompt shows again next load, which is the harmless
 * direction to fail in.
 */
function readAnswer(): Answer | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

function writeAnswer(a: Answer): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, a);
  } catch {
    /* private mode: the answer just does not persist */
  }
}

export class FullscreenPrompt {
  private el: HTMLDivElement | null = null;

  /**
   * Build the prompt, or return null when it should not be shown.
   *
   * The gate, in order:
   *   - `?fsprompt=0` suppresses it outright (captures, tooling).
   *   - `?fsprompt=1` forces it past the device test and any stored answer, so
   *     it can be inspected on a desktop and re-offered after a "no". It does
   *     NOT bypass the feature detect: a YES that does nothing stays impossible.
   *   - otherwise: touch-primary device (the SAME `isTouchPrimary()` the touch
   *     overlay uses — there is no second device test), API present, no stored
   *     answer, and not already fullscreen.
   */
  static offer(): FullscreenPrompt | null {
    let force = false;
    try {
      const p = new URLSearchParams(window.location.search).get('fsprompt');
      if (p === '0') return null;
      force = p === '1';
    } catch { /* no search params: fall through to the normal gate */ }

    if (!fullscreenSupported()) return null;
    if (!force) {
      if (!isTouchPrimary()) return null;
      if (readAnswer() !== null) return null;
      if (isFullscreen()) return null;
    }
    return new FullscreenPrompt();
  }

  private constructor() {
    injectStyles();

    const el = document.createElement('div');
    el.className = 'cp-fsprompt';
    el.innerHTML =
      '<div class="txt">Play fullscreen?</div>' +
      '<button class="cp-fs-btn no" type="button">NO</button>' +
      '<button class="cp-fs-btn yes" type="button">YES</button>';
    this.el = el;

    const yes = el.querySelector('.cp-fs-btn.yes') as HTMLButtonElement;
    const no = el.querySelector('.cp-fs-btn.no') as HTMLButtonElement;

    yes.addEventListener('click', () => {
      // FIRST — the browser only honours this while the activation from this
      // very click is still live. Nothing may run before it.
      const el2 = document.documentElement as FsElement;
      const req = typeof el2.requestFullscreen === 'function'
        ? el2.requestFullscreen({ navigationUI: 'hide' })
        : el2.webkitRequestFullscreen?.();
      // A rejection here (user agent said no, or the activation was stale) is
      // not worth an error dialog — the game just stays windowed. Swallow it so
      // it does not surface as an unhandled rejection.
      void Promise.resolve(req).catch(() => {});
      writeAnswer('yes');
      this.close();
    });

    no.addEventListener('click', () => {
      writeAnswer('no');
      this.close();
    });

    document.body.appendChild(el);
    // Next frame so the entrance transition has a start state to move from.
    requestAnimationFrame(() => el.classList.add('show'));
  }

  /** True while the pill is on screen. */
  get isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * Take the pill away without recording anything. Used by dispose(); an answer
   * goes through the button handlers, which write first and then land here.
   */
  private close(): void {
    this.el?.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }
}
