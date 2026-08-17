import { t, language, onLanguageChange, type StringKey } from "../i18n";
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from "./settings";
import { enterFullscreen, isFullscreen, fullscreenWanted } from "./fullscreen";
import { injectStyles } from "./styles";
import { seedPadButtons } from "../core/gamepad";
import type { InputSource } from "../core/input";

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
  /** Which device last spoke, so the hint line names one set of controls. */
  inputSource?: () => InputSource;
  /** `by` is here because re-taking pointer lock is only safe after a click. */
  onClose?: (by: CloseBy) => void;
  onAction: (action: PauseAction) => void;
}

const svg = (path: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;

/** A gear outline on the 24-grid; round joins soften the corners. */
const gearPath = (teeth: number, rOut: number, rIn: number): string => {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    for (const [r, da] of [
      [rIn, -0.27],
      [rOut, -0.16],
      [rOut, 0.16],
      [rIn, 0.27],
    ] as const) {
      const th = a + da * step;
      pts.push(`${(12 + Math.cos(th) * r).toFixed(2)} ${(12 + Math.sin(th) * r).toFixed(2)}`);
    }
  }
  return `M${pts.join("L")}Z`;
};

/* Duotone: `.f` parts are filled at low alpha, everything else is a stroke.
   Exit sits OPPOSITE Continue: the one destructive sector is never one slip from the primary. */
const WHEEL_SECTORS: readonly WheelSector[] = [
  {
    id: "continue",
    icon: svg(
      '<path class="f" d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7Z"/>' +
        '<path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7Z"/>',
    ),
    label: "pause.continue",
    action: "continue",
  },
  {
    id: "bag",
    icon: svg(
      '<path class="f" d="M5 9.5h14a1 1 0 0 1 1 1.1l-1 8.9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5l-1-8.9a1 1 0 0 1 1-1.1Z"/>' +
        '<path d="M5 9.5h14a1 1 0 0 1 1 1.1l-1 8.9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5l-1-8.9a1 1 0 0 1 1-1.1Z"/>' +
        '<path d="M8.5 9.5V7a3.5 3.5 0 0 1 7 0v2.5M4.6 13.2h14.8"/>' +
        '<path class="f" d="M10.6 12.2h2.8v2.4h-2.8z"/><path d="M10.6 12.2h2.8v2.4h-2.8z"/>',
    ),
    label: "pause.inventory",
    action: "inventory",
  },
  {
    id: "journal",
    icon: svg(
      '<path class="f" d="M12 6.4c-2.9-1.7-5.9-1.9-8.5-1v13.2c2.6-.9 5.6-.7 8.5 1V6.4Z"/>' +
        '<path d="M12 6.4c-2.9-1.7-5.9-1.9-8.5-1v13.2c2.6-.9 5.6-.7 8.5 1m0-13.2c2.9-1.7 5.9-1.9 8.5-1v13.2c-2.6-.9-5.6-.7-8.5 1m0-13.2v13.2"/>' +
        '<path d="M14.6 9.6c1.2-.4 2.3-.5 3.4-.4m-3.4 3.3c1.2-.4 2.3-.5 3.4-.4m-3.4 3.3c1.2-.4 2.3-.5 3.4-.4"/>',
    ),
    label: "pause.journal",
    action: "journal",
  },
  {
    id: "map",
    icon: svg(
      '<path class="f" d="M9 4.5l6 2v13l-6-2z"/>' +
        '<path d="M3.5 6.5 9 4.5l6 2 5.5-2v13L15 19.5l-6-2-5.5 2v-13ZM9 4.5v13m6-11v13"/>' +
        '<path d="M5.5 14.6c1.4-2.9 2.8-3.4 4.2-1.5s2.4 1.6 3.9-1" stroke-dasharray="1.5 1.7"/>' +
        '<circle class="f" cx="17.6" cy="9.4" r="1.5"/>',
    ),
    label: "pause.map",
    action: "map",
  },
  {
    id: "exit",
    icon: svg(
      '<path class="f" d="M5 4h8v16H5z"/>' +
        '<path d="M13 4H5v16h8M17.5 8l4 4-4 4m4-4H10"/><circle cx="10.2" cy="12" r=".6"/>',
    ),
    label: "pause.exit",
    action: "exit",
  },
  {
    id: "settings",
    icon: svg(
      `<path class="f" d="${gearPath(8, 9.3, 7.2)}"/><path d="${gearPath(8, 9.3, 7.2)}"/>` +
        '<circle cx="12" cy="12" r="3.1"/>',
    ),
    label: "pause.settings",
    action: "settings",
  },
  {
    id: "controls",
    icon: svg(
      '<path class="f" d="M7.5 8.5h9a4.5 4.5 0 0 1 4.2 6.1l-1.3 3.4a2.2 2.2 0 0 1-3.6.7L14 16.5h-4l-1.8 2.2a2.2 2.2 0 0 1-3.6-.7l-1.3-3.4A4.5 4.5 0 0 1 7.5 8.5Z"/>' +
        '<path d="M7.5 8.5h9a4.5 4.5 0 0 1 4.2 6.1l-1.3 3.4a2.2 2.2 0 0 1-3.6.7L14 16.5h-4l-1.8 2.2a2.2 2.2 0 0 1-3.6-.7l-1.3-3.4A4.5 4.5 0 0 1 7.5 8.5ZM8.2 11.2v3.8m-1.9-1.9h3.8"/>' +
        '<circle class="f" cx="15.4" cy="12.1" r="1"/><circle class="f" cx="17.6" cy="14.1" r="1"/>',
    ),
    label: "pause.controls",
    action: "controls",
  },
];

/** Wheel geometry, in the SVG's 100-unit box; the button ring sits mid-band. */
const WHEEL_R_OUT = 47;
const WHEEL_R_IN = 20;
const WHEEL_GAP = 0.8;
const WHEEL_R_RIM = 48;
const SECTOR_STEP = (Math.PI * 2) / WHEEL_SECTORS.length;
const sectorAngle = (i: number): number => i * SECTOR_STEP - Math.PI / 2;
/** How long `.closing` plays before the element goes; matches the CSS. */
const CLOSE_MS = 200;
/** Entrance order: from the top sector down both sides at once. */
const sectorRank = (i: number): number => Math.min(i, WHEEL_SECTORS.length - i);

const polar = (r: number, a: number): string =>
  `${(50 + Math.cos(a) * r).toFixed(3)} ${(50 + Math.sin(a) * r).toFixed(3)}`;

/** An annular wedge with a constant-width gap to its neighbours. */
const wedgePath = (i: number): string => {
  const a = sectorAngle(i);
  const half = SECTOR_STEP / 2;
  const gO = WHEEL_GAP / WHEEL_R_OUT;
  const gI = WHEEL_GAP / WHEEL_R_IN;
  return (
    `M${polar(WHEEL_R_OUT, a - half + gO)}` +
    `A${WHEEL_R_OUT} ${WHEEL_R_OUT} 0 0 1 ${polar(WHEEL_R_OUT, a + half - gO)}` +
    `L${polar(WHEEL_R_IN, a + half - gI)}` +
    `A${WHEEL_R_IN} ${WHEEL_R_IN} 0 0 0 ${polar(WHEEL_R_IN, a - half + gI)}Z`
  );
};

/** The rim arc that slides to the aimed sector, drawn for sector 0 and rotated. */
const aimArcPath = (): string => {
  const a = sectorAngle(0);
  const half = SECTOR_STEP / 2 - WHEEL_GAP / WHEEL_R_RIM;
  return (
    `M${polar(WHEEL_R_RIM, a - half)}` +
    `A${WHEEL_R_RIM} ${WHEEL_R_RIM} 0 0 1 ${polar(WHEEL_R_RIM, a + half)}`
  );
};

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
  /** The element outlives `isOpen` for CLOSE_MS while the out transition plays. */
  private closeTimer = 0;
  /** Accumulated rim-arc angle, so a change of sector always takes the short way round. */
  private aimDeg = 0;
  /** Pad edge detection: held last frame, went down this one. */
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padAxisLatched = false;
  private padAxisLatchedX = false;
  private padAiming = false;

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
    return this.el !== null && !this.closeTimer;
  }
  /** Read by the probe in tools/. */
  get currentStep(): Step | null {
    return this.isOpen ? this.step : null;
  }

  open(): void {
    if (this.isOpen) {
      return;
    }
    this.removeNow();
    this.step = "wheel";
    this.selectedIdx = null;
    this.padAiming = false;
    this.aimDeg = 0;
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

  /**
   * Restore fullscreen unless Exit is handing control to the title screen.
   * `animate` plays the out transition; a handoff to another panel removes at once.
   */
  close(restoreFullscreen = true, by: CloseBy = "click", animate = true): void {
    if (!this.isOpen || !this.el) {
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
    this.padAiming = false;
    this.focusables = [];
    this.selectedIdx = null;
    if (animate) {
      this.el.classList.add("closing");
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.closeTimer = window.setTimeout(() => this.removeNow(), CLOSE_MS);
    } else {
      this.removeNow();
    }
    this.hooks.onClose?.(by);
  }

  private removeNow(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = 0;
    }
    this.el?.remove();
    this.el = null;
  }

  /** Returns whether the press was spent; shut means it was not ours. */
  onEscape(): boolean {
    if (!this.isOpen) {
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
    this.close(true, "click", false);
    this.removeNow();
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
    const hint = t(this.hintKey());
    const mid = (WHEEL_R_OUT + WHEEL_R_IN) / 2 + 1;
    const wedges = WHEEL_SECTORS.map(
      (_, i) =>
        `<path class="wedge" data-wedge="${i}" d="${wedgePath(i)}" ` +
        `style="--k:${sectorRank(i)}"/>`,
    ).join("");
    const sectors = WHEEL_SECTORS.map((sector, i) => {
      const angle = sectorAngle(i);
      const left = 50 + Math.cos(angle) * mid;
      const top = 50 + Math.sin(angle) * mid;
      return (
        `<button class="bs-wheel-sector" type="button" role="menuitem" ` +
        `style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;--k:${sectorRank(i)}" ` +
        `data-sector="${i}" data-id="${sector.id}" data-act="${sector.action}">` +
        `<span class="ic">${sector.icon}</span>` +
        `<span class="lb">${escapeHtml(t(sector.label))}</span></button>`
      );
    }).join("");
    return (
      `<div class="bs-wheel" role="menu" aria-label="${escapeHtml(t("pause.title"))}">` +
      `<svg class="bs-wheel-face" viewBox="0 0 100 100" aria-hidden="true">` +
      `<defs>` +
      `<radialGradient id="bsWheelDark" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="${WHEEL_R_OUT}">` +
      `<stop offset=".42" stop-color="#2d2318"/><stop offset="1" stop-color="#15100b"/></radialGradient>` +
      `<radialGradient id="bsWheelLit" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="${WHEEL_R_OUT}">` +
      `<stop offset=".42" stop-color="#e8b452"/><stop offset="1" stop-color="#f8d98a"/></radialGradient>` +
      `<radialGradient id="bsWheelHub" cx="50%" cy="38%" r="70%">` +
      `<stop offset="0" stop-color="#3a2a17"/><stop offset="1" stop-color="#140d07"/></radialGradient>` +
      `</defs>` +
      `<circle class="rim" cx="50" cy="50" r="${WHEEL_R_RIM}"/>` +
      `<g class="wedges">${wedges}</g>` +
      `<g class="aimwrap"><path class="aim" d="${aimArcPath()}"/></g>` +
      `<circle class="hub" cx="50" cy="50" r="17.6"/>` +
      `<circle class="hubring" cx="50" cy="50" r="15.2"/>` +
      `</svg>` +
      `<div class="bs-wheel-sectors">${sectors}</div>` +
      `<div class="bs-wheel-hub" aria-live="polite"><span class="name"></span></div>` +
      `</div><p class="bs-wheel-hint" data-source="${this.hintSource}">${escapeHtml(hint)}</p>`
    );
  }

  private hintSource: InputSource = "kbm";
  private hintKey(): StringKey {
    this.hintSource = this.hooks.inputSource?.() ?? "kbm";
    return `pause.hint.${this.hintSource}`;
  }

  /** Re-derive the hint when the player switches device with the wheel up. */
  private syncHint(): void {
    const hint = this.el?.querySelector<HTMLElement>(".bs-wheel-hint");
    if (!hint) {
      return;
    }
    const before = this.hintSource;
    const key = this.hintKey();
    if (this.hintSource !== before) {
      hint.textContent = t(key);
      hint.dataset.source = this.hintSource;
    }
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
    this.padAiming = false;
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
    if (!this.isOpen || (this.step === "wheel" && fromGamepad && !this.padAimHeld())) {
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

  private clearPadSelection(): void {
    if (!this.padAiming) {
      return;
    }
    this.padAiming = false;
    this.setSelection(null, false);
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.closest(".bs-wheel")) {
      active.blur();
    }
  }

  private setSelection(idx: number | null, focus = true): void {
    if (this.step !== "wheel" || !this.el) {
      return;
    }
    const changed = this.selectedIdx !== idx;
    this.selectedIdx = idx;
    for (const button of this.el.querySelectorAll<HTMLButtonElement>("[data-sector]")) {
      button.classList.toggle("selected", Number(button.dataset.sector) === idx);
    }
    for (const wedge of this.el.querySelectorAll<SVGPathElement>("[data-wedge]")) {
      wedge.classList.toggle("selected", Number(wedge.dataset.wedge) === idx);
    }
    const wheel = this.el.querySelector<HTMLElement>(".bs-wheel");
    const name = this.el.querySelector<HTMLElement>(".bs-wheel-hub .name:not(.out)");
    if (wheel && changed) {
      wheel.classList.toggle("aimed", idx !== null);
      if (idx !== null) {
        const target = (idx / WHEEL_SECTORS.length) * 360;
        const delta = ((target - (this.aimDeg % 360) + 540) % 360) - 180;
        this.aimDeg += delta;
        wheel.style.setProperty("--aim", `${this.aimDeg}deg`);
      }
      if (name) {
        // A fresh element per change so the crossfade replays; the old one fades out and goes.
        const next = document.createElement("span");
        next.className = idx === null ? "name idle" : "name";
        next.textContent = idx === null ? t("pause.title") : t(WHEEL_SECTORS[idx].label);
        name.after(next);
        name.classList.add("out");
        name.addEventListener("animationend", () => name.remove(), { once: true });
        this.el.querySelectorAll(".bs-wheel-hub .name.out").forEach((old, i, all) => {
          if (i < all.length - 1) {
            old.remove();
          }
        });
      }
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
    const turn = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    this.setSelection(Math.round(turn / SECTOR_STEP) % WHEEL_SECTORS.length);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.step !== "wheel" || !this.el || e.pointerType === "touch") {
      return;
    }
    const wheel = this.el.querySelector(".bs-wheel");
    if (!wheel) {
      return;
    }
    const idx = this.sectorAt(wheel, e.clientX, e.clientY);
    if (idx === null) {
      this.setSelection(null);
    } else {
      this.setSelection(idx);
    }
  };

  /** Which sector a screen point is over, or null inside the hub. */
  private sectorAt(wheel: Element, clientX: number, clientY: number): number | null {
    const rect = wheel.getBoundingClientRect();
    const x = clientX - (rect.left + rect.width / 2);
    const y = clientY - (rect.top + rect.height / 2);
    if (Math.hypot(x, y) < rect.width * (WHEEL_R_IN / 100)) {
      return null;
    }
    const turn = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return Math.round(turn / SECTOR_STEP) % WHEEL_SECTORS.length;
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !this.isOpen || !this.el) {
      return;
    }
    let btn = target.closest("button") as HTMLButtonElement | null;
    const wheel = target.closest(".bs-wheel");
    if (!btn && wheel) {
      // A tap on the wedge itself, away from the button — touch never aimed it.
      const idx = this.sectorAt(wheel, e.clientX, e.clientY);
      if (idx !== null) {
        btn = this.el.querySelector(`[data-sector="${idx}"]`);
      }
    }
    if (!btn) {
      return;
    }

    if (this.settings.handleClick(btn)) {
      return;
    }

    const action = btn.getAttribute("data-act");
    if (action === "continue") {
      this.el.querySelector(`[data-wedge="${btn.dataset.sector}"]`)?.classList.add("confirmed");
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
      // The destination panel takes the screen at once; two panels fading is mush.
      this.close(sector.action !== "exit", "click", false);
      this.hooks.onAction(sector.action);
    }
  };

  /** Own poll: `GamepadControls` owns button edges; the wheel only needs axes. */
  private pollPad = (): void => {
    if (!this.el) {
      return;
    }
    this.padRaf = requestAnimationFrame(this.pollPad);
    this.syncHint();

    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads?.() ?? []) {
        if (p?.connected) {
          pad = p;
          break;
        }
      }
    } catch {
      this.clearPadSelection();
      return;
    }
    if (!pad) {
      this.padDown.fill(0);
      this.clearPadSelection();
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
        this.padAiming = true;
        this.selectDirection(stickX, stickY);
      } else {
        this.clearPadSelection();
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
