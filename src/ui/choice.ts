/**
 * THE CHOICE PANEL (issue #166) — a modal that asks one question and takes one
 * answer from a short list. Built for the campaign's last objective, `decide`,
 * and for nothing else yet, so it is small on purpose: a title, two to four
 * option buttons each with a line of consequence under it, and a hint row.
 *
 * THE PANEL OWNS THE SCREEN; THE HOST OWNS WHAT A PICK MEANS (AGENTS.md): it
 * is handed the options as display strings and an id per option, and it
 * reports the id picked. It never reads content, never runs an action, and
 * never decides that a choice is final — the host does, where the exclusivity
 * of the ending flags is enforced.
 *
 * INPUT, per the modal rule: a modal takes the input, never the clock. Escape
 * is NOT read here — main.ts's cancel branch closes the topmost modal and calls
 * `onEscape` — and neither is the pad's B (a virtual Escape). Digits, arrows,
 * Enter/Space (real buttons) and the pad's stick/dpad/A are handled here, the
 * same way the journal does it.
 */
import { t } from "../i18n";
import { injectStyles } from "./styles";

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  /** One line of consequence, already localised. Optional. */
  readonly detail?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

/** Why it closed: a pick, the host's cancel, or a programmatic close. The host's lock rule reads it. */
export type ChoiceCloseBy = "pick" | "escape" | "host";

export interface ChoiceHooks {
  onOpen?: () => void;
  onClose?: (by: ChoiceCloseBy) => void;
}

export class ChoicePanel {
  private el: HTMLDivElement | null = null;
  private buttons: HTMLButtonElement[] = [];
  private onPick: ((id: string) => void) | null = null;
  private padRaf = 0;
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padLatchY = false;

  constructor(private readonly hooks: ChoiceHooks = {}) {
    injectStyles();
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Ask. `onPick` fires once, after the panel has closed; a dismissal fires nothing. */
  open(title: string, options: readonly ChoiceOption[], onPick: (id: string) => void): void {
    if (this.el) {
      this.close("host");
    }
    this.onPick = onPick;
    const el = document.createElement("div");
    el.className = "bs-choice";
    el.innerHTML =
      '<div class="bs-scrim"></div>' +
      '<section class="pane bs-glass" role="dialog" aria-modal="true">' +
      `<h2>${escapeHtml(title)}</h2>` +
      '<div class="opts"></div>' +
      `<p class="foot">${escapeHtml(t("choice.hint"))}</p>` +
      "</section>";
    const opts = el.querySelector(".opts")!;
    this.buttons = options.map((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.dataset.id = o.id;
      b.innerHTML =
        `<span class="n">${i + 1}</span>` +
        `<span class="txt"><b>${escapeHtml(o.label)}</b>` +
        (o.detail ? `<small>${escapeHtml(o.detail)}</small>` : "") +
        "</span>";
      b.addEventListener("click", () => this.pick(o.id));
      opts.appendChild(b);
      return b;
    });
    document.body.appendChild(el);
    this.el = el;
    // Two frames in, so the CSS transition has a start state to leave.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("open")));
    this.buttons[0]?.focus();
    window.addEventListener("keydown", this.onKeyDown, true);
    this.padRaf = requestAnimationFrame(this.pollPad);
    this.hooks.onOpen?.();
  }

  close(by: ChoiceCloseBy = "host"): void {
    if (!this.el) {
      return;
    }
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.buttons = [];
    this.onPick = null;
    this.hooks.onClose?.(by);
  }

  /** The host's cancel: dismissed, nothing picked. True when the press was spent. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    this.close("escape");
    return true;
  }

  /** For a host driving this from `Input` (the pad's confirm). */
  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  private pick(id: string): void {
    const fn = this.onPick;
    this.close("pick");
    fn?.(id);
  }

  private moveFocus(d: number): void {
    const n = this.buttons.length;
    if (n === 0) {
      return;
    }
    const here = this.buttons.indexOf(document.activeElement as HTMLButtonElement);
    this.buttons[((here < 0 ? 0 : here) + d + n) % n].focus();
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.el || ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
      ev.preventDefault();
      this.moveFocus(1);
    } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      this.moveFocus(-1);
    } else if (/^[1-9]$/.test(ev.key)) {
      const b = this.buttons[Number(ev.key) - 1];
      if (b) {
        ev.preventDefault();
        b.click();
      }
    }
  };

  /** See `InventoryPanel.pollPad`: stick and dpad move the focus, A confirms; B is the host's Escape. */
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
    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      this.padEdge[i] = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padDown[i] = now;
    }
    const stickY = pad.axes[1] ?? 0;
    const dirY = stickY < -0.5 ? -1 : stickY > 0.5 ? 1 : 0;
    if (dirY === 0) {
      this.padLatchY = false;
    }
    let move = 0;
    if (this.padEdge[12]) {
      move = -1;
    } else if (this.padEdge[13]) {
      move = 1;
    } else if (dirY !== 0 && !this.padLatchY) {
      move = dirY;
      this.padLatchY = true;
    }
    if (move) {
      this.moveFocus(move);
    }
    if (this.padEdge[0]) {
      this.activate();
    }
  };
}
