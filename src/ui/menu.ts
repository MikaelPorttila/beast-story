import { isTouchPrimary } from "../core/touch";
import { loadPrefs, type Prefs } from "../core/prefs";
import type { SaveMeta } from "../core/saves";
import { flags } from "../core/flags";
import { t, language, onLanguageChange } from "../i18n";
import { enterFullscreen, fullscreenSurvivesEscape } from "./fullscreen";
import { SettingsPanel, FOCUSABLE, type SettingsHooks } from "./settings";
import { aboutMarkup } from "./about";
import { injectStyles } from "./styles";
import bgUrl from "./menu-bg.webp";
import logoUrl from "./menu-logo.webp";

/**
 * The title screen. Steps: press -> options -> {settings|about|name|load}.
 *
 * The two .webp files are imported, not in `public/`: `base:'./'` means a build
 * can be served from any subfolder and Vite does not rewrite string literals.
 * `.plate` reproduces `background-size:cover` in explicit numbers so the lamp
 * glows, sized in per-cent of the plate, stay on the lanterns at any aspect.
 */

interface Lamp {
  /** Centre and diameter of the glow, as fractions of the picture. */
  x: number;
  y: number;
  r: number;
  /** Seconds per pulse. Co-prime-ish so the three never sync up. */
  period: number;
}

/** Measured off `menu-bg.webp` (1672x941); fractions survive a re-export. */
const LAMPS: ReadonlyArray<Lamp> = [
  { x: 84 / 1672, y: 670 / 941, r: 0.115, period: 4.3 },
  { x: 609 / 1672, y: 728 / 941, r: 0.065, period: 3.1 },
  { x: 1579 / 1672, y: 677 / 941, r: 0.115, period: 5.2 },
];

/** Hand-placed, not randomised, so captures are comparable across loads. */
interface Fairy {
  top: number; // per cent of viewport height
  size: number; // px at 1080p, scaled by the sprite's own glow
  duration: number; // seconds to cross
  delay: number; // negative: start mid-flight
  bob: number; // seconds per vertical wobble
  bobY: number; // px of wobble
  reverse: boolean; // right-to-left
  hue: "warm" | "cool";
}

/** 8-15px: anything smaller vanishes against the painting's noon sky. */
const FAIRIES: ReadonlyArray<Fairy> = [
  { top: 18, size: 12, duration: 26, delay: -3, bob: 3.1, bobY: 26, reverse: false, hue: "warm" },
  { top: 34, size: 9, duration: 34, delay: -19, bob: 4.2, bobY: 18, reverse: true, hue: "cool" },
  { top: 52, size: 15, duration: 21, delay: -11, bob: 2.7, bobY: 32, reverse: false, hue: "warm" },
  { top: 27, size: 8, duration: 41, delay: -30, bob: 5.1, bobY: 14, reverse: true, hue: "warm" },
  { top: 63, size: 11, duration: 29, delay: -7, bob: 3.6, bobY: 22, reverse: false, hue: "cool" },
  { top: 44, size: 9, duration: 37, delay: -24, bob: 4.7, bobY: 16, reverse: true, hue: "warm" },
  { top: 11, size: 10, duration: 31, delay: -15, bob: 3.3, bobY: 20, reverse: false, hue: "cool" },
];

type Step = "press" | "options" | "name" | "load" | "settings" | "about";

/** Px per arrow/d-pad nudge on the About step — about three lines at 16px. */
const ABOUT_SCROLL = 64;

/**
 * Three-beat entrance: logo, painting, "press start". Issue #49.
 *
 * JS decides only WHEN it starts; the stylesheet owns the ordering in
 * `animation-delay`, because long boot tasks delayed a 550 ms `setTimeout` to
 * 4066 ms. Waits on `decode()` first, capped. Skipped under `photo=1` and on
 * Exit to title — both jump straight to `lit`.
 */
const INTRO = {
  decodeCap: 2500,
  /** Whole sequence, ms: logo .55 + art .7 + press .45. Match ui/styles.ts. */
  total: 1700,
} as const;

export interface StartMenuHooks extends SettingsHooks {
  /** Fired once, after the menu has faded out and left the DOM. */
  onStart: (name: string) => void;
  /** PREPARE the load; split from `onBegin` so a failure still has a screen. */
  onLoad?: (id: number) => Promise<boolean>;
  onBegin?: () => void;
  /** Newest first. Asked once, at build, since it gates the Load button. */
  listSaves?: () => Promise<SaveMeta[]>;
  onDeleteSave?: (id: number) => Promise<void>;
  /** The exit fade STARTED: what you draw is now being seen. Before `onStart`. */
  onLeave?: () => void;
}

export interface StartMenuOptions {
  /** Open on the options step. For Exit to title, which has no splash. */
  skipSplash?: boolean;
}

/** `?menu=` — 0 suppresses the menu, 1 forces it into a staged capture. */
function menuParam(): "0" | "1" | null {
  try {
    const v = new URLSearchParams(window.location.search).get("menu");
    return v === "0" || v === "1" ? v : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

export class StartMenu {
  private el: HTMLDivElement | null = null;
  private step: Step = "press";
  private prefs: Prefs;
  private settings: SettingsPanel;
  private unlisten: (() => void) | null = null;
  private padRaf = 0;
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  /** Selector for the button the NEXT panel build should focus. */
  private pendingFocus: string | null = null;
  /** Pad edge detection: held last frame, and went down this one. */
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padAxisLatched = false;
  private padAxisLatchedX = false;
  /** Entrance start, `performance.now()`. 0 = awaiting images, -1 = no sequence. */
  private introAt = 0;
  private saves: SaveMeta[] = [];
  /** The character whose Delete has been pressed ONCE, or null. */
  private armedDelete: number | null = null;
  private loadError = false;

  /**
   * Build the menu, or null when the game should just start. `menu=0`
   * suppresses; `menu=1` forces it even in photo mode; else shown unless `photo=1`.
   */
  static offer(hooks: StartMenuHooks, opts: StartMenuOptions = {}): StartMenu | null {
    const p = menuParam();
    if (p === "0") {
      return null;
    }
    if (p !== "1" && flags.photo) {
      return null;
    }
    return new StartMenu(hooks, p === "1" && flags.photo, opts);
  }

  private constructor(
    private hooks: StartMenuHooks,
    private frozen: boolean,
    opts: StartMenuOptions,
  ) {
    injectStyles();
    this.prefs = loadPrefs();
    this.settings = new SettingsPanel("title", hooks);
    // `focusables` is built by `renderPanel` and nowhere else, so a tab change
    // asks for a full rebuild rather than patching the DOM behind our back.
    this.settings.onRebuild = (focus) => {
      this.pendingFocus = focus;
      this.renderPanel();
    };
    if (opts.skipSplash) {
      this.step = "options";
    }

    const el = document.createElement("div");
    el.className = `bs-menu${this.frozen ? " photo" : ""}`;
    el.setAttribute("data-step", this.step);
    el.innerHTML = this.markup();
    this.el = el;
    document.body.appendChild(el);

    // A language change rebuilds: the panel is markup per step, not captions.
    this.unlisten = onLanguageChange(() => {
      this.pendingFocus = `[data-lang="${language()}"]`;
      this.renderPanel();
    });

    el.addEventListener("click", this.onClick);
    window.addEventListener("keydown", this.onKeyDown, true);
    this.renderPanel();
    this.pollPad();
    // Asked here, not on Load: the answer decides whether Load can BE pressed.
    void this.refreshSaves();

    // Next frame so the entrance transition has a start state to move from.
    requestAnimationFrame(() => el.classList.add("show"));

    if (this.frozen || opts.skipSplash) {
      this.finishIntro();
    } else {
      void this.runIntro();
    }
  }

  private finishIntro(): void {
    this.introAt = -1;
    this.el?.classList.remove("intro");
    this.el?.classList.add("lit");
  }

  private get introOver(): boolean {
    return this.introAt < 0 || performance.now() - this.introAt >= INTRO.total;
  }

  private static ready(img: HTMLImageElement | null): Promise<unknown> {
    if (!img) {
      return Promise.resolve();
    }
    return Promise.race([
      img.decode?.().catch(() => undefined) ?? Promise.resolve(),
      new Promise((r) => window.setTimeout(r, INTRO.decodeCap)),
    ]);
  }

  private async runIntro(): Promise<void> {
    const el = this.el;
    if (!el) {
      return;
    }
    // In parallel: the stylesheet orders them on SCREEN.
    await Promise.all([
      StartMenu.ready(el.querySelector<HTMLImageElement>("img.logo")),
      StartMenu.ready(el.querySelector<HTMLImageElement>("img.art")),
    ]);
    // Disposed or skipped while waiting: animating now re-fades from black.
    if (this.el !== el || this.introAt !== 0) {
      return;
    }
    this.introAt = performance.now();
    el.classList.add("intro");
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Which step is showing. Read by tools/test-menu.mjs; not used internally. */
  get currentStep(): Step {
    return this.step;
  }

  private markup(): string {
    const lamps = LAMPS.map(
      (l) =>
        `<i class="lamp" style="--x:${(l.x * 100).toFixed(2)}%;--y:${(l.y * 100).toFixed(2)}%;` +
        `--r:${(l.r * 100).toFixed(2)}%;--p:${l.period}s"></i>`,
    ).join("");

    const fairies = FAIRIES.map(
      (f) =>
        `<i class="fly${f.reverse ? " rev" : ""} ${f.hue}" style="--top:${f.top}%;--sz:${f.size}px;` +
        `--dur:${f.duration}s;--delay:${f.delay}s;--bob:${f.bob}s;--bobY:${f.bobY}px"><b></b></i>`,
    ).join("");

    return (
      '<div class="stage">' +
      '<div class="plate">' +
      `<img class="art" src="${bgUrl}" alt="" draggable="false">` +
      lamps +
      "</div>" +
      `<div class="flies">${fairies}</div>` +
      '<div class="vign"></div>' +
      "</div>" +
      '<div class="fore">' +
      `<img class="logo" src="${logoUrl}" ` +
      `alt="${escapeHtml(t("menu.title"))}" draggable="false">` +
      '<div class="panel"></div>' +
      "</div>"
    );
  }

  /** One node's innerHTML, so the logo's slide survives. Sole writer of `focusables`. */
  private renderPanel(): void {
    const el = this.el;
    if (!el) {
      return;
    }
    const panel = el.querySelector(".panel") as HTMLDivElement;
    const logo = el.querySelector(".logo") as HTMLImageElement | null;
    if (logo) {
      logo.alt = t("menu.title");
    }
    el.setAttribute("data-step", this.step);

    if (this.step === "press") {
      panel.innerHTML = `<div class="press">${escapeHtml(t("menu.pressStart"))}</div>`;
    } else if (this.step === "options") {
      const canLoad = this.saves.length > 0;
      panel.innerHTML =
        '<div class="bs-opts">' +
        this.btn("new", t("menu.newGame"), "primary") +
        this.btn("load", t("menu.load"), canLoad ? "" : "disabled") +
        (canLoad ? "" : `<div class="note">${escapeHtml(t("menu.load.unavailable"))}</div>`) +
        this.btn("settings", t("menu.settings")) +
        this.btn("about", t("menu.about")) +
        "</div>";
    } else if (this.step === "name") {
      // Optional field: empty falls back to `saves.nameDefault`, so a pad player
      // who cannot type is never blocked.
      panel.innerHTML =
        '<div class="bs-opts name-step">' +
        `<h2>${escapeHtml(t("saves.namePrompt"))}</h2>` +
        '<input class="bs-name-input" type="text" maxlength="24" autocomplete="off" ' +
        `spellcheck="false" aria-label="${escapeHtml(t("saves.namePrompt"))}" ` +
        `placeholder="${escapeHtml(t("saves.nameDefault"))}">` +
        this.btn("begin", t("saves.begin"), "primary") +
        this.btn("back", t("menu.back")) +
        "</div>";
    } else if (this.step === "load") {
      panel.innerHTML =
        '<div class="bs-opts load-step">' +
        `<h2>${escapeHtml(t("menu.load"))}</h2>` +
        (this.loadError
          ? `<div class="note warn">${escapeHtml(t("saves.loadFailed"))}</div>`
          : "") +
        (this.saves.length === 0
          ? `<div class="note">${escapeHtml(t("saves.empty"))}</div>`
          : this.saves.map((s) => this.saveRow(s)).join("")) +
        this.btn("back", t("menu.back")) +
        "</div>";
    } else if (this.step === "about") {
      panel.innerHTML =
        '<div class="bs-opts about-step">' +
        aboutMarkup() +
        this.btn("back", t("menu.back")) +
        "</div>";
    } else {
      panel.innerHTML =
        '<div class="bs-opts settings">' +
        this.settings.markup() +
        this.btn("back", t("menu.back")) +
        "</div>";
    }

    // FOCUSABLE, not "every button": strips are one control each and hidden
    // sections are still in the DOM.
    this.focusables = Array.from(panel.querySelectorAll(FOCUSABLE));
    // By SELECTOR, never an inherited index — an index outlives the list it
    // pointed into and lands the cursor on the wrong button.
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? panel.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    // The name field takes the cursor, so it needs no click before typing.
    const field = panel.querySelector<HTMLInputElement>(".bs-name-input");
    if (field && !found) {
      field.focus();
    } else {
      this.focusables[this.focusIdx]?.focus();
    }
  }

  private btn(action: string, label: string, mod = ""): string {
    const dis = mod === "disabled" ? " disabled" : "";
    return (
      `<button class="bs-menu-btn ${mod}" type="button" data-act="${action}"${dis}>` +
      `${escapeHtml(label)}</button>`
    );
  }

  /** Date via `toLocaleString`, not i18n: the platform knows the player's calendar. */
  private saveRow(s: SaveMeta): string {
    const armed = this.armedDelete === s.id;
    const when = new Date(s.updatedAt).toLocaleString();
    return (
      '<div class="bs-save-row">' +
      `<button class="bs-menu-btn save" type="button" data-act="slot" data-id="${s.id}">` +
      `<span class="nm">${escapeHtml(s.name || t("saves.nameDefault"))}</span>` +
      `<span class="meta">${escapeHtml(t("saves.power", { n: String(s.powerLevel) }))}` +
      ` · ${escapeHtml(when)}</span>` +
      "</button>" +
      `<button class="bs-menu-btn del${armed ? " armed" : ""}" type="button" ` +
      `data-act="del" data-id="${s.id}">` +
      `${escapeHtml(armed ? t("saves.deleteConfirm") : t("saves.delete"))}</button>` +
      "</div>"
    );
  }

  /** Keeps the cursor by selector: this can land while the player walks the list. */
  private async refreshSaves(): Promise<void> {
    if (!this.hooks.listSaves) {
      return;
    }
    let next: SaveMeta[] = [];
    try {
      next = await this.hooks.listSaves();
    } catch {
      next = []; // no store, or it failed: same screen as no characters
    }
    if (!this.el) {
      return;
    } // disposed while the read was in flight
    this.saves = next;
    if (this.step !== "options" && this.step !== "load") {
      return;
    }
    const act = (document.activeElement as HTMLElement | null)?.getAttribute("data-act");
    this.pendingFocus = act ? `[data-act="${act}"]` : null;
    this.renderPanel();
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) {
      return;
    }

    // Step one takes ANY click, anywhere on the poster.
    if (this.step === "press") {
      this.advanceFromPress();
      return;
    }

    const btn = target.closest("button") as HTMLButtonElement | null;
    if (!btn) {
      return;
    }

    // The settings list claims its own rows; anything it refuses is ours.
    if (this.settings.handleClick(btn)) {
      this.prefs = this.settings.values;
      return;
    }

    switch (btn.getAttribute("data-act")) {
      case "new":
        this.goto("name");
        break;
      case "begin":
        this.beginNew();
        break;
      case "load":
        this.goto("load");
        break;
      case "slot":
        this.loadSlot(Number(btn.getAttribute("data-id")));
        break;
      case "del":
        this.pressDelete(Number(btn.getAttribute("data-id")));
        break;
      case "settings":
        this.goto("settings");
        break;
      case "about":
        this.goto("about");
        break;
      case "back":
        this.leaveLeaf();
        break;
      default:
        break;
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el) {
      return;
    }
    // Modifier-only presses are not "any button" — a hand on Shift would skip it.
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
      return;
    }
    // F5, F12 and the devtools keys stay the browser's.
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) {
      return;
    }

    if (this.step === "press") {
      e.preventDefault();
      this.advanceFromPress();
      return;
    }

    // `stopPropagation` is required: this listener captures, `Input`'s bubbles,
    // and `Input.CAPTURED` preventDefaults WASD/Space — "Wisp" typed as "ip".
    // Only the three form keys are spent here.
    if (this.step === "name" && document.activeElement instanceof HTMLInputElement) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        this.beginNew();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.leaveLeaf();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.moveFocus(e.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        if (!this.scrollAbout(1)) {
          this.moveFocus(1);
        }
        break;
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        if (!this.scrollAbout(-1)) {
          this.moveFocus(-1);
        }
        break;
      case "ArrowLeft":
      case "ArrowRight":
        // Left/right changes the strip's VALUE, not the focus inside it.
        if (this.settings.stepGroup(document.activeElement, e.key === "ArrowRight" ? 1 : -1)) {
          e.preventDefault();
        }
        break;
      case "Escape":
        if (this.step !== "options") {
          e.preventDefault();
          this.leaveLeaf();
        }
        break;
      default:
        break; // Enter/Space land on the focused <button> natively
    }
  };

  private moveFocus(d: number): void {
    if (!this.focusables.length) {
      return;
    }
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    this.focusIdx = (from + d + this.focusables.length) % this.focusables.length;
    this.focusables[this.focusIdx].focus();
  }

  /**
   * Own poll, not `GamepadControls`: a menu wants edges only, no integrated axes.
   * A pad press is no user activation, so a controller start stays windowed.
   */
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
      return; // no Gamepad API: keyboard and touch still work
    }
    if (!pad) {
      // Unplugged: forget held state, or it reads as a press when a pad returns.
      this.padDown.fill(0);
      return;
    }

    // One sweep over EVERY button — that is what "press any button" means.
    let any = false;
    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      const edge = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padEdge[i] = edge;
      this.padDown[i] = now;
      if (edge) {
        any = true;
      }
    }

    if (this.step === "press") {
      if (any) {
        this.advanceFromPress();
      }
      return;
    }

    // W3C standard mapping: 12/13 d-pad up/down, 14/15 left/right, axes 0/1 the
    // left stick. Latched so a held stick steps once, not per frame.
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
    if (move && !this.scrollAbout(move)) {
      this.moveFocus(move);
    }

    // Left/right changes the SECTION, not the focus among its four buttons.
    let step = 0;
    if (this.padEdge[14]) {
      step = -1;
    } else if (this.padEdge[15]) {
      step = 1;
    } else if (dirX !== 0 && !this.padAxisLatchedX) {
      step = dirX;
      this.padAxisLatchedX = true;
    }
    if (step && this.step === "settings") {
      this.settings.stepGroup(document.activeElement, step as -1 | 1);
    }

    // A activates, B goes back — the same faces core/gamepad.ts names.
    if (this.padEdge[0]) {
      (document.activeElement as HTMLButtonElement | null)?.click();
    } else if (this.padEdge[1] && this.step !== "options") {
      this.leaveLeaf();
    }
  };

  private advanceFromPress(): void {
    if (this.step !== "press") {
      return;
    }
    // Mid-entrance a press FINISHES the intro: "press start" is not up yet.
    if (!this.introOver) {
      this.finishIntro();
      return;
    }
    this.goto("options");
  }

  /** Back to the options, cursor on the button that opened the leaf. */
  private leaveLeaf(): void {
    const from =
      this.step === "about"
        ? "about"
        : this.step === "name"
          ? "new"
          : this.step === "load"
            ? "load"
            : "settings";
    // Leaving disarms Delete, or a stale "Confirm?" deletes on the next press.
    this.armedDelete = null;
    this.loadError = false;
    this.goto("options", `[data-act="${from}"]`);
  }

  /** Returns whether the key was spent. Gated on the element, not `this.step`. */
  private scrollAbout(dir: number): boolean {
    const box = this.el?.querySelector<HTMLElement>(".about");
    if (!box) {
      return false;
    }
    box.scrollTop += dir * ABOUT_SCROLL;
    return true;
  }

  private goto(step: Step, focus?: string): void {
    this.step = step;
    this.pendingFocus = focus ?? null;
    this.renderPanel();
  }

  private beginNew(): void {
    const field = this.el?.querySelector<HTMLInputElement>(".bs-name-input");
    const typed = (field?.value ?? "").trim().slice(0, 24);
    this.takeFullscreen();
    this.leave(() => this.hooks.onStart(typed || t("saves.nameDefault")));
  }

  /** Fullscreen must stay the first statement, ahead of the await. */
  private async loadSlot(id: number): Promise<void> {
    if (!Number.isFinite(id) || !this.hooks.onLoad) {
      return;
    }
    this.takeFullscreen();
    const ok = await this.hooks.onLoad(id);
    if (!this.el) {
      return;
    } // disposed while the read was in flight
    if (!ok) {
      // Re-read: the likeliest reason a character will not load is that it is gone.
      this.loadError = true;
      void this.refreshSaves();
      this.renderPanel();
      return;
    }
    this.leave(() => this.hooks.onBegin?.());
  }

  /** Two presses: arm, then delete. A press on another row moves the arming. */
  private pressDelete(id: number): void {
    if (!Number.isFinite(id) || !this.hooks.onDeleteSave) {
      return;
    }
    if (this.armedDelete !== id) {
      this.armedDelete = id;
      this.pendingFocus = `[data-act="del"][data-id="${id}"]`;
      this.renderPanel();
      return;
    }
    this.armedDelete = null;
    void this.hooks
      .onDeleteSave(id)
      .then(() => this.refreshSaves())
      .then(() => {
        // An emptied list leaves the Load step with nothing but Back on it.
        if (this.step === "load" && this.saves.length === 0) {
          this.leaveLeaf();
        }
      });
  }

  /**
   * BEFORE ANYTHING ELSE THE PRESS DOES: `requestFullscreen()` is honoured only
   * while the browser can still attribute it to the press. `fs=` beats the
   * preference without writing it back; the survives-Escape gate is issue #83.
   */
  private takeFullscreen(): void {
    if (flags.autoFullscreen ?? (this.prefs.autoFullscreen && fullscreenSurvivesEscape())) {
      enterFullscreen();
    }
  }

  /** Fade out, leave the DOM, THEN run `then`. Fullscreen is the caller's. */
  private leave(then: () => void): void {
    const el = this.el;
    if (!el) {
      return;
    }
    el.classList.add("leaving");
    // First: from this moment the poster is see-through.
    this.hooks.onLeave?.();
    const done = (): void => {
      if (!this.el) {
        return;
      } // disposed mid-fade
      this.close();
      then();
    };
    // Timer is the net for a transition that never runs; `close()` is idempotent.
    // BOTH EVENT GUARDS ARE LOAD-BEARING: `transitionend` bubbles, and the
    // clicked button's own .14s transform otherwise cut the dissolve short.
    el.addEventListener("transitionend", function onEnd(e: TransitionEvent) {
      if (e.target !== el || e.propertyName !== "opacity") {
        return;
      }
      el.removeEventListener("transitionend", onEnd);
      done();
    });
    window.setTimeout(done, 700);
  }

  private close(): void {
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    this.unlisten?.();
    this.unlisten = null;
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.el?.remove();
    this.el = null;
  }

  dispose(): void {
    this.close();
  }
}
