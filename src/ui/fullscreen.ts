import { t } from '../i18n';
import { injectStyles } from './styles';

/**
 * "Play fullscreen?" — a two-button pill, raised by the start menu as its own
 * step, on every device that can honour the answer.
 *
 * WHY IT IS A SEPARATE OVERLAY AND NOT A HUD CHILD
 *
 * `.bs-root` is `z-index:20`, which makes it a stacking context, so a child of
 * it can never hit-test above the touch overlay at `z-index:30` — and the pill
 * has to sit over the corner the transparent look pad owns. So this is a
 * body-level sibling at `z-index:40`, built and removed by this module alone.
 * Its CSS still lives in `ui/styles.ts` with the rest of the HUD sheet
 * (`bs-fsprompt` / `bs-fs-btn`), and it follows the same rule everything else
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
 * NOTHING IS REMEMBERED, and that is a deliberate reversal.
 *
 * This module used to store the answer under `bs:fullscreen-prompt` and never
 * ask again, because it raised itself unbidden on the game's first frame and a
 * pill that reappears mid-walk every session is a nag. It no longer raises
 * itself: the start menu asks it, once, as the step between pressing start and
 * choosing New Game (see ui/menu.ts). At that moment "you already answered this
 * in another session" is not a reason to skip it — the answer frames the whole
 * session, the player is deciding to play rather than being interrupted, and a
 * phone that has since been rotated or lent to somebody else has a different
 * right answer. With no gate left to read, there is nothing worth writing
 * either, so the key is gone rather than left behind write-only.
 */

/** Which button was pressed. Reported to whoever raised the prompt. */
export type Answer = 'yes' | 'no';

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


/** How a prompt is being raised. See `ask`. */
export interface FullscreenAskOptions {
  /**
   * True when the start menu is showing it as its own step. It moves the pill
   * off its in-game perch — the 264px clearance below exists to dodge the touch
   * sticks, and on a title screen there are none — and centres it under the
   * logo instead.
   */
  inMenu?: boolean;
  /** Fired after either answer, once the pill has taken itself off the DOM. */
  onAnswer?: (answer: Answer) => void;
}

export class FullscreenPrompt {
  private el: HTMLDivElement | null = null;

  /**
   * Build the prompt, or return null when it should not be shown.
   *
   * The gate, in order:
   *   - `?fsprompt=0` suppresses it outright (captures, tooling).
   *   - `?fsprompt=0` suppresses it outright (captures, tooling).
   *   - `?fsprompt=1` forces it past the "already fullscreen" test.
   *   - otherwise: the API is present and the page is not already fullscreen.
   *
   * EVERY DEVICE, not just touch. This asked only on touch-primary hardware
   * at first, inheriting the gate from the days when it raised itself over a
   * live game and a desktop player could hit F11 themselves. As a deliberate
   * step in the start menu that reasoning is gone: a mouse-and-keyboard player
   * has just as much reason to be asked once, at the moment they decide to
   * play, and most of them do not think of F11.
   *
   * The feature detect stays, and it is the only device test left. On an iPhone
   * there is no element-level Fullscreen API at all, so the step is skipped
   * rather than offering a YES that cannot do anything. Also note what is NOT
   * in the list any more: a stored answer. See the header.
   */
  static ask(opts: FullscreenAskOptions = {}): FullscreenPrompt | null {
    let force = false;
    try {
      const p = new URLSearchParams(window.location.search).get('fsprompt');
      if (p === '0') return null;
      force = p === '1';
    } catch { /* no search params: fall through to the normal gate */ }

    if (!fullscreenSupported()) return null;
    if (!force && isFullscreen()) return null;
    return new FullscreenPrompt(opts);
  }

  private constructor(private opts: FullscreenAskOptions = {}) {
    injectStyles();

    const el = document.createElement('div');
    el.className = `bs-fsprompt${opts.inMenu ? ' in-menu' : ''}`;
    // YES FIRST. The order is the reading order and the focus order at once:
    // this is an offer, so the thing being offered leads, and the cursor starts
    // on it without having to be sent there against the grain of the markup.
    // (It was NO then YES, which put the affirmative answer last and made the
    // menu's default focus jump over a button to reach it.)
    el.innerHTML =
      `<div class="txt">${t('fs.prompt')}</div>` +
      `<button class="bs-fs-btn yes" type="button">${t('fs.yes')}</button>` +
      `<button class="bs-fs-btn no" type="button">${t('fs.no')}</button>`;
    this.el = el;

    const yes = el.querySelector('.bs-fs-btn.yes') as HTMLButtonElement;
    const no = el.querySelector('.bs-fs-btn.no') as HTMLButtonElement;

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
      this.answer('yes');
    });

    no.addEventListener('click', () => {
      this.answer('no');
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
   * Record an answer, take the pill down, and tell whoever raised it.
   *
   * The callback fires LAST, after the node is gone, because the start menu's
   * handler moves straight on to the options — and the pill sits where those
   * options are about to be drawn.
   */
  private answer(a: Answer): void {
    this.close();
    this.opts.onAnswer?.(a);
  }

  /**
   * Take the pill away without recording anything. Used by dispose(); an answer
   * goes through `answer` above, which writes first and then lands here.
   */
  private close(): void {
    this.el?.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }
}
