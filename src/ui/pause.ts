import { t, language, onLanguageChange } from "../i18n";
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from "./settings";
import { enterFullscreen, isFullscreen, fullscreenWanted } from "./fullscreen";
import { injectStyles } from "./styles";

/**
 * In-game menu: a modal with a cursor. Sibling of ui/menu.ts, reusing its
 * settings list and `.bs-menu-btn` / `.bs-opts`. A cancel means "up one".
 */

type Step = "menu" | "settings";
export type CloseBy = "key" | "click";

export interface PauseMenuHooks extends SettingsHooks {
  onOpen?: () => void;
  /** `by` is here because re-taking pointer lock is only safe after a CLICK. */
  onClose?: (by: CloseBy) => void;
  onExit: () => void;
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

export class PauseMenu {
  private el: HTMLDivElement | null = null;
  private step: Step = "menu";
  private settings: SettingsPanel;
  private unlisten: (() => void) | null = null;
  private padRaf = 0;
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private pendingFocus: string | null = null;
  /** Pad edge detection: held last frame, went down this one. */
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padAxisLatched = false;
  private padAxisLatchedX = false;

  constructor(private hooks: PauseMenuHooks) {
    injectStyles();
    // 'game' disables the language picker: it cannot be changed mid-session.
    this.settings = new SettingsPanel("game", hooks);
    // A real rebuild, not a DOM patch: `focusables` is built by `render` alone.
    this.settings.onRebuild = (focus) => {
      this.pendingFocus = focus;
      this.render();
    };
  }

  get isOpen(): boolean {
    return this.el !== null;
  }
  /** Read by the probe in tools/. */
  get currentStep(): Step | null {
    return this.el ? this.step : null;
  }

  open(): void {
    if (this.el) {
      return;
    }
    this.step = "menu";
    const el = document.createElement("div");
    el.className = "bs-pause";
    el.innerHTML = '<div class="bs-scrim"></div><div class="pane"></div>';
    this.el = el;
    document.body.appendChild(el);

    // Only reachable for a change made at the title screen; kept for parity.
    this.unlisten = onLanguageChange(() => {
      this.pendingFocus = `[data-lang="${language()}"]`;
      this.render();
    });

    el.addEventListener("click", this.onClick);
    window.addEventListener("keydown", this.onKeyDown, true);
    this.render();
    this.pollPad();
    // Next frame so the entrance transition has a start state.
    requestAnimationFrame(() => el.classList.add("open"));
    this.hooks.onOpen?.();
  }

  /**
   * `restoreFullscreen` is false only for Exit, which wants a windowed title.
   * The restore is the fallback for browsers with no keyboard lock, where Escape
   * drops fullscreen first; it asks the game's INTENT because `isFullscreen()`
   * would already sample false, and only a CLICK carries the activation
   * `requestFullscreen()` needs. Those browsers also drop pointer lock ~8 ms
   * later, so `by` tells the host to re-take it after a CLICK only.
   */
  close(restoreFullscreen = true, by: CloseBy = "click"): void {
    if (!this.el) {
      return;
    }
    // Before the DOM work: a click handler's request has a deadline.
    if (restoreFullscreen && fullscreenWanted() && !isFullscreen()) {
      enterFullscreen();
    }
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener("keydown", this.onKeyDown, true);
    // A button still down at close would read as a fresh press on the next open.
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.hooks.onClose?.(by);
  }

  /** Returns whether the press was spent; shut means it was not ours. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    if (this.step === "settings") {
      this.goto("menu", '[data-act="settings"]');
    } else {
      this.close(true, "key");
    }
    return true;
  }

  dispose(): void {
    this.close();
  }

  private render(): void {
    const el = this.el;
    if (!el) {
      return;
    }
    const pane = el.querySelector(".pane") as HTMLDivElement;
    el.setAttribute("data-step", this.step);

    if (this.step === "menu") {
      pane.innerHTML =
        '<div class="bs-opts">' +
        `<h2>${escapeHtml(t("pause.title"))}</h2>` +
        this.btn("continue", t("pause.continue"), "primary") +
        this.btn("settings", t("pause.settings")) +
        this.btn("exit", t("pause.exit")) +
        "</div>";
    } else {
      pane.innerHTML =
        '<div class="bs-opts settings">' +
        this.settings.markup() +
        this.btn("back", t("menu.back")) +
        "</div>";
    }

    // FOCUSABLE, not "every button": a strip is one control, and hidden sections
    // are still in the DOM.
    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    // A selector, not an index: an index outlives the list it pointed into.
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  private btn(action: string, label: string, mod = ""): string {
    return (
      `<button class="bs-menu-btn ${mod}" type="button" data-act="${action}">` +
      `${escapeHtml(label)}</button>`
    );
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.pendingFocus = focus ?? null;
    this.render();
  }

  /**
   * Escape is deliberately absent: it also arrives virtually from the pad and
   * touch, so handling the real key here would spend one press twice and close
   * two steps. The host owns that edge (`onEscape`).
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        this.moveFocus(1);
        break;
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        this.moveFocus(-1);
        break;
      case "ArrowLeft":
      case "ArrowRight":
        // Changes the strip's VALUE; `false` means an ordinary row.
        if (this.settings.stepGroup(document.activeElement, e.key === "ArrowRight" ? 1 : -1)) {
          e.preventDefault();
        }
        break;
      default:
        break;
    }
  };

  moveFocus(d: number): void {
    if (!this.focusables.length) {
      return;
    }
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    this.focusIdx = (from + d + this.focusables.length) % this.focusables.length;
    this.focusables[this.focusIdx].focus();
  }

  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !this.el) {
      return;
    }
    // The scrim is not a way out: a stray click must not land near Exit.
    const btn = target.closest("button") as HTMLButtonElement | null;
    if (!btn) {
      return;
    }

    if (this.settings.handleClick(btn)) {
      return;
    }

    switch (btn.getAttribute("data-act")) {
      case "continue":
        this.close();
        break;
      case "settings":
        this.goto("settings");
        break;
      case "back":
        this.goto("menu", '[data-act="settings"]');
        break;
      case "exit":
        // Closed FIRST, so the host's teardown runs with no menu on screen.
        this.close(false);
        this.hooks.onExit();
        break;
      default:
        break;
    }
  };

  /** Own poll: `GamepadControls` feeds held actions, a menu wants edges. */
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
        } // first connected pad wins
      }
    } catch {
      return; // no Gamepad API: keyboard, pointer and touch still work
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

    // W3C mapping: 12/13 d-pad up/down, 14/15 left/right, axes 1/0 left stick.
    const stickY = pad.axes[1] ?? 0;
    const dirY = stickY < -0.5 ? -1 : stickY > 0.5 ? 1 : 0;
    if (dirY === 0) {
      this.padAxisLatched = false;
    }
    const stickX = pad.axes[0] ?? 0;
    const dirX = stickX < -0.5 ? -1 : stickX > 0.5 ? 1 : 0;
    if (dirX === 0) {
      this.padAxisLatchedX = false;
    }

    let move = 0;
    if (this.padEdge[12]) {
      move = -1;
    } else if (this.padEdge[13]) {
      move = 1;
    } else if (dirY !== 0 && !this.padAxisLatched) {
      move = dirY;
      this.padAxisLatched = true;
    }
    if (move) {
      this.moveFocus(move);
    }

    let step = 0;
    if (this.padEdge[14]) {
      step = -1;
    } else if (this.padEdge[15]) {
      step = 1;
    } else if (dirX !== 0 && !this.padAxisLatchedX) {
      step = dirX;
      this.padAxisLatchedX = true;
    }
    if (step) {
      this.settings.stepGroup(document.activeElement, step as -1 | 1);
    }

    // B is not read here: `GamepadControls` already taps a virtual Escape for it.
    if (this.padEdge[0]) {
      this.activate();
    }
  };
}
