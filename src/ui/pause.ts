import { t, language, onLanguageChange, type StringKey } from "../i18n";
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from "./settings";
import { enterFullscreen, isFullscreen, fullscreenWanted } from "./fullscreen";
import { injectStyles } from "./styles";
import { seedPadButtons } from "../core/gamepad";

/** In-game action wheel and its nested settings panel. */

type Step = "wheel" | "settings";
export type CloseBy = "key" | "click";
export type PauseAction = "inventory" | "journal" | "map" | "controls" | "exit";

interface WheelSector {
  id: string;
  icon: string;
  label: StringKey;
  action: PauseAction | "continue" | "settings";
}

export interface PauseMenuHooks extends SettingsHooks {
  onOpen?: () => void;
  /** `by` is here because re-taking pointer lock is only safe after a click. */
  onClose?: (by: CloseBy) => void;
  onAction: (action: PauseAction) => void;
}

const svg = (path: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

const WHEEL_SECTORS: readonly WheelSector[] = [
  {
    id: "continue",
    icon: svg('<path d="m9 5 10 7L9 19V5Z"/>'),
    label: "pause.continue",
    action: "continue",
  },
  {
    id: "bag",
    icon: svg('<path d="M6 8h12l1 12H5L6 8Zm3 0V6a3 3 0 0 1 6 0v2"/>'),
    label: "pause.inventory",
    action: "inventory",
  },
  {
    id: "journal",
    icon: svg(
      '<path d="M5 4h5a3 3 0 0 1 2 1 3 3 0 0 1 2-1h5v15h-5a3 3 0 0 0-2 1 3 3 0 0 0-2-1H5V4Z"/>',
    ),
    label: "pause.journal",
    action: "journal",
  },
  {
    id: "map",
    icon: svg('<path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Zm5-2v14m6-12v14"/>'),
    label: "pause.map",
    action: "map",
  },
  {
    id: "controls",
    icon: svg(
      '<path d="M7 9h10a4 4 0 0 1 3.7 5.5l-1.2 3a2 2 0 0 1-3.2.7L14 16h-4l-2.3 2.2a2 2 0 0 1-3.2-.7l-1.2-3A4 4 0 0 1 7 9Zm0 3v4m-2-2h4m7-1h.01m2 2h.01"/>',
    ),
    label: "pause.controls",
    action: "controls",
  },
  {
    id: "settings",
    icon: svg(
      '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5 1 2.1 2.3.5 1.8-1.5 2.3 2.3-1.5 1.8.5 2.3 2.1 1v3.2l-2.1 1-.5 2.3 1.5 1.8-2.3 2.3-1.8-1.5-2.3.5-1 2.1H10l-1-2.1-2.3-.5-1.8 1.5-2.3-2.3 1.5-1.8-.5-2.3-2.1-1v-3.2l2.1-1 .5-2.3-1.5-1.8 2.3-2.3 1.8 1.5L9 5.6l1-2.1h2Z"/>',
    ),
    label: "pause.settings",
    action: "settings",
  },
  {
    id: "exit",
    icon: svg('<path d="M10 4H5v16h5m3-4 4-4-4-4m4 4H9"/>'),
    label: "pause.exit",
    action: "exit",
  },
];

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

export class PauseMenu {
  private el: HTMLDivElement | null = null;
  private step: Step = "wheel";
  private settings: SettingsPanel;
  private unlisten: (() => void) | null = null;
  private padRaf = 0;
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private selectedIdx: number | null = null;
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
    this.step = "wheel";
    this.selectedIdx = null;
    const el = document.createElement("div");
    el.className = "bs-pause";
    el.innerHTML = '<div class="bs-scrim"></div><div class="pane"></div>';
    this.el = el;
    document.body.appendChild(el);

    this.unlisten = onLanguageChange(() => {
      this.pendingFocus =
        this.step === "wheel" ? '[data-act="continue"]' : `[data-lang="${language()}"]`;
      this.render();
    });

    el.addEventListener("click", this.onClick);
    el.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("keydown", this.onKeyDown, true);
    this.render();
    seedPadButtons(this.padDown);
    this.pollPad();
    requestAnimationFrame(() => el.classList.add("open"));
    this.hooks.onOpen?.();
  }

  /** Restore fullscreen unless Exit is handing control to the title screen. */
  close(restoreFullscreen = true, by: CloseBy = "click"): void {
    if (!this.el) {
      return;
    }
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
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.selectedIdx = null;
    this.hooks.onClose?.(by);
  }

  /** Returns whether the press was spent; shut means it was not ours. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    if (this.step === "settings") {
      this.goto("wheel", '[data-act="settings"]');
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

    if (this.step === "wheel") {
      pane.innerHTML = this.wheelMarkup();
    } else {
      pane.innerHTML =
        '<div class="bs-opts settings">' +
        this.settings.markup() +
        this.btn("back", t("menu.back")) +
        "</div>";
    }

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
    if (this.step === "wheel") {
      const action = this.focusables[this.focusIdx]?.dataset.act;
      const idx = WHEEL_SECTORS.findIndex((sector) => sector.action === action);
      this.setSelection(idx >= 0 ? idx : null, false);
    }
  }

  private wheelMarkup(): string {
    const sectors = WHEEL_SECTORS.map((sector, i) => {
      const angle = (i / WHEEL_SECTORS.length) * Math.PI * 2 - Math.PI / 2;
      const left = 50 + Math.cos(angle) * 35;
      const top = 50 + Math.sin(angle) * 35;
      return (
        `<button class="bs-wheel-sector" type="button" role="menuitem" ` +
        `style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%" ` +
        `data-sector="${i}" data-id="${sector.id}" data-act="${sector.action}">` +
        `<span class="ic">${sector.icon}</span>` +
        `<span>${escapeHtml(t(sector.label))}</span></button>`
      );
    }).join("");
    return (
      `<div class="bs-wheel" role="menu" aria-label="${escapeHtml(t("pause.title"))}">` +
      `<div class="bs-wheel-sectors">${sectors}</div>` +
      `</div><p class="bs-wheel-hint">${escapeHtml(t("pause.hint"))}</p>`
    );
  }

  private btn(action: string, label: string, mod = ""): string {
    return (
      `<button class="bs-menu-btn ${mod}" type="button" data-act="${action}">` +
      `${escapeHtml(label)}</button>`
    );
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.selectedIdx = null;
    if (step === "settings") {
      this.padAxisLatched = true;
      this.padAxisLatchedX = true;
    }
    this.pendingFocus = focus ?? null;
    this.render();
  }

  /** Escape stays host-owned because pad B and keyboard Escape share that edge. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el || e.ctrlKey || e.metaKey || e.altKey) {
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
      case "ArrowRight": {
        const step = e.key === "ArrowRight" ? 1 : -1;
        if (this.step === "wheel") {
          e.preventDefault();
          this.moveFocus(step);
        } else if (this.settings.stepGroup(document.activeElement, step)) {
          e.preventDefault();
        }
        break;
      }
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
    const next = this.focusables[this.focusIdx];
    next.focus();
    if (this.step === "wheel") {
      const idx = Number(next.dataset.sector);
      this.setSelection(Number.isInteger(idx) ? idx : null, false);
    }
  }

  activate(fromGamepad = false): void {
    if (this.step === "wheel" && fromGamepad && !this.padAimHeld()) {
      return;
    }
    const active = document.activeElement as HTMLButtonElement | null;
    const selected =
      this.selectedIdx === null
        ? null
        : this.el?.querySelector<HTMLButtonElement>(`[data-sector="${this.selectedIdx}"]`);
    (selected ?? active)?.click();
  }

  private padAimHeld(): boolean {
    try {
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (pad?.connected && Math.hypot(pad.axes[0] ?? 0, pad.axes[1] ?? 0) > 0.5) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private setSelection(idx: number | null, focus = true): void {
    if (this.step !== "wheel" || !this.el) {
      return;
    }
    this.selectedIdx = idx;
    for (const button of this.el.querySelectorAll<HTMLButtonElement>("[data-sector]")) {
      button.classList.toggle("selected", Number(button.dataset.sector) === idx);
    }
    if (idx === null) {
      if (focus) {
        this.el.querySelector<HTMLButtonElement>('[data-act="continue"]')?.focus();
      }
      return;
    }
    const button = this.el.querySelector<HTMLButtonElement>(`[data-sector="${idx}"]`);
    if (focus) {
      button?.focus();
    }
    const focusIdx = button ? this.focusables.indexOf(button) : -1;
    if (focusIdx >= 0) {
      this.focusIdx = focusIdx;
    }
  }

  private selectDirection(x: number, y: number): void {
    const angle = Math.atan2(y, x) + Math.PI / 2;
    const turn = (angle + Math.PI * 2) % (Math.PI * 2);
    const idx = Math.round((turn / (Math.PI * 2)) * WHEEL_SECTORS.length) % WHEEL_SECTORS.length;
    this.setSelection(idx);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.step !== "wheel" || !this.el || e.pointerType === "touch") {
      return;
    }
    const wheel = this.el.querySelector(".bs-wheel");
    if (!wheel) {
      return;
    }
    const rect = wheel.getBoundingClientRect();
    const x = e.clientX - (rect.left + rect.width / 2);
    const y = e.clientY - (rect.top + rect.height / 2);
    if (Math.hypot(x, y) < rect.width * 0.16) {
      this.setSelection(null);
    } else {
      this.selectDirection(x, y);
    }
  };

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !this.el) {
      return;
    }
    let btn = target.closest("button") as HTMLButtonElement | null;
    if (!btn && target.closest(".bs-wheel") && this.selectedIdx !== null) {
      btn = this.el.querySelector(`[data-sector="${this.selectedIdx}"]`);
    }
    if (!btn) {
      return;
    }

    if (this.settings.handleClick(btn)) {
      return;
    }

    const action = btn.getAttribute("data-act");
    if (action === "continue") {
      this.close();
    } else if (action === "settings") {
      this.goto("settings");
    } else if (action === "back") {
      this.goto("wheel", '[data-act="settings"]');
    } else {
      const sector = WHEEL_SECTORS.find((item) => item.action === action);
      if (!sector || sector.action === "continue" || sector.action === "settings") {
        return;
      }
      this.close(sector.action !== "exit");
      this.hooks.onAction(sector.action);
    }
  };

  /** Own poll: `GamepadControls` owns button edges; the wheel only needs axes. */
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

    this.padEdge.fill(0);
    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      this.padEdge[i] = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padDown[i] = now;
    }

    const stickX = pad.axes[0] ?? 0;
    const stickY = pad.axes[1] ?? 0;
    if (this.step === "wheel") {
      if (Math.hypot(stickX, stickY) > 0.5) {
        this.selectDirection(stickX, stickY);
      }
    } else {
      const dirY = stickY < -0.5 ? -1 : stickY > 0.5 ? 1 : 0;
      if (dirY === 0) {
        this.padAxisLatched = false;
      }
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
    }
  };
}
