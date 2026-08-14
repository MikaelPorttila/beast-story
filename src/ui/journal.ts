import { t, type StringKey } from "../i18n";
import { injectStyles } from "./styles";
import { CHECK_ICON, CLOSE_ICON } from "./icons";
import { Tooltip, type TipContent } from "./tooltip";

/**
 * Quest journal (issue #98). A modal right-hand dock: main.ts freezes the hero
 * and releases pointer lock while it is up. Knows no quest rules — it is handed
 * a `JournalModel` of display strings and reports HUD toggles back.
 */

/** See `InvCloseBy` in ui/inventory.ts — same three values. */
export type JournalCloseBy = "escape" | "hotkey" | "click";

export type JournalTab = "active" | "available" | "completed";

const TABS: readonly { id: JournalTab; key: StringKey }[] = [
  { id: "active", key: "journal.tab.active" },
  { id: "available", key: "journal.tab.available" },
  { id: "completed", key: "journal.tab.completed" },
];

/** A name in an objective's prose that has a preview (issue #246). Derived from
 *  the quest's STRUCTURED trigger by the host, never parsed out of the text —
 *  `name` is the display name as the current language writes it, `tip` the id
 *  the host's `tipFor` resolves (`beast:sproutle`, `item:red-shard`, …). */
export interface JournalHover {
  name: string;
  tip: string;
}

/** `need` is 1 for a boolean objective. */
export interface JournalObjective {
  text: string;
  have: number;
  need: number;
  hovers?: readonly JournalHover[];
}

export interface JournalReward {
  label: string;
  value: string;
}

export interface JournalEntry {
  id: string;
  name: string;
  description?: string;
  category: "main" | "side";
  tab: JournalTab;
  /** A label, not an id — see content/types/quest.ts. */
  arc?: string;
  giver?: string;
  location?: string;
  objectives: readonly JournalObjective[];
  rewards: readonly JournalReward[];
  /** Only meaningful when active. */
  onHud: boolean;
}

export interface JournalModel {
  entries: readonly JournalEntry[];
}

export interface JournalHooks {
  model: () => JournalModel;
  onToggleHud: (id: string) => void;
  /** Resolves a `JournalHover.tip` id to preview content, or null for no tip. */
  tipFor?: (id: string) => TipContent | null;
  onOpen?: () => void;
  onClose?: (by: JournalCloseBy) => void;
}

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

/**
 * The tab to open on: the first with anything on it, in `TABS` order.
 *
 * The order IS the priority — what you are doing, then what is offered, then
 * what is done — so the strip's order and the opening tab can never disagree.
 * All three empty falls back to the first, which is the shelf whose empty line
 * is the one worth reading ("nothing on the go").
 */
function firstFilled(model: JournalModel): JournalTab {
  const filled = TABS.find((tb) => model.entries.some((e) => e.tab === tb.id));
  return filled?.id ?? TABS[0].id;
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

export class JournalPanel {
  private el: HTMLDivElement | null = null;
  private tip = new Tooltip();
  private tab: JournalTab = "active";
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private pendingFocus: string | null = null;
  private padRaf = 0;
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padLatchY = false;
  private padLatchX = false;

  constructor(private hooks: JournalHooks) {
    injectStyles();
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** For the probe. */
  get activeTab(): JournalTab {
    return this.tab;
  }

  open(): void {
    if (this.el) {
      return;
    }
    // WHICH SHELF OPENS IS DERIVED, never remembered: the panel is opened to ask
    // "what am I doing", so it lands on the first tab that has an answer —
    // active, then offered, then done. A remembered tab shows an empty shelf to
    // a player whose last visit ended on one, which is the state a turn-in
    // leaves behind.
    this.tab = firstFilled(this.hooks.model());
    const el = document.createElement("div");
    el.className = "bs-journal";
    el.innerHTML = '<div class="bs-scrim"></div><aside class="pane bs-glass"></aside>';
    this.el = el;
    this.tip.attach(el);
    document.body.appendChild(el);
    el.addEventListener("click", this.onClick);
    // Desktop-only by construction, exactly as the inventory's: touch has no hover.
    el.addEventListener("pointerover", this.onPointerOver);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerout", this.onPointerOut);
    window.addEventListener("keydown", this.onKeyDown, true);
    this.render();
    this.pollPad();
    requestAnimationFrame(() => el.classList.add("open"));
    this.hooks.onOpen?.();
  }

  close(by: JournalCloseBy = "click"): void {
    if (!this.el) {
      return;
    }
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.padDown.fill(0);
    this.tip.detach();
    this.el.remove();
    this.el = null;
    this.focusables = [];
    // Back to the default, so the NEXT open is a fresh derivation and not the
    // tail of this visit.
    this.tab = "active";
    this.hooks.onClose?.(by);
  }

  toggle(): void {
    if (this.el) {
      this.close("hotkey");
    } else {
      this.open();
    }
  }

  /** Required, not a courtesy: a quest can advance while the panel is up. */
  refresh(): void {
    if (this.el) {
      this.render();
    }
  }

  /** Returns whether this panel SPENT the press. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    this.close("escape");
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
    const model = this.hooks.model();
    const pane = el.querySelector(".pane") as HTMLElement;
    const list = model.entries.filter((e) => e.tab === this.tab);

    pane.innerHTML =
      `<div class="head"><h2>${escapeHtml(t("journal.title"))}</h2></div>` +
      this.tabsHtml(model) +
      `<div class="list">${
        list.length
          ? list.map((e) => this.cardHtml(e)).join("")
          : `<p class="none">${escapeHtml(t(EMPTY_KEYS[this.tab]))}</p>`
      }</div>`;

    const head = pane.querySelector(".head") as HTMLElement;
    head.insertAdjacentHTML("beforeend", `<span class="cap">${kbd("J")}${kbd("Esc")}</span>`);
    const closeBtn = document.createElement("button");
    closeBtn.className = "bs-shop-x";
    closeBtn.type = "button";
    closeBtn.dataset.act = "close";
    closeBtn.innerHTML = CLOSE_ICON;
    head.appendChild(closeBtn);

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  private tabsHtml(model: JournalModel): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      const n = model.entries.reduce((sum, e) => sum + (e.tab === tb.id ? 1 : 0), 0);
      return (
        `<button class="chip tab${on ? " on" : ""}" type="button" role="tab"` +
        ` data-tab="${tb.id}" aria-selected="${on}"${on ? "" : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.key))}<b>${n}</b></button>`
      );
    }).join("")}</div>`;
  }

  /** HUD toggle only on the active shelf — `hudRows` in main.ts filters the same way. */
  private cardHtml(e: JournalEntry): string {
    const done = e.objectives.every((o) => o.have >= o.need);
    const meta = [e.arc, e.giver, e.location].filter((s): s is string => !!s);
    return (
      `<article class="q c-${e.category}${done ? " done" : ""}" data-quest="${escapeHtml(e.id)}">` +
      '<div class="q-h">' +
      `<span class="badge">${escapeHtml(t(e.category === "main" ? "journal.main" : "journal.side"))}</span>` +
      `<h3>${escapeHtml(e.name)}</h3>` +
      "</div>" +
      (meta.length ? `<p class="q-m">${meta.map(escapeHtml).join(" · ")}</p>` : "") +
      (e.description ? `<p class="q-d">${escapeHtml(e.description)}</p>` : "") +
      (e.objectives.length
        ? `<ul class="steps">${e.objectives.map((o) => this.stepHtml(o)).join("")}</ul>`
        : "") +
      (e.rewards.length
        ? `<div class="bs-chips">${e.rewards
            .map(
              (r) =>
                `<span class="bs-chip">${escapeHtml(r.label)} <b>${escapeHtml(r.value)}</b></span>`,
            )
            .join("")}</div>`
        : "") +
      (e.tab === "active"
        ? '<div class="q-f">' +
          `<button class="bs-buy ghost${e.onHud ? " on" : ""}" type="button"` +
          ` data-hud="${escapeHtml(e.id)}" aria-pressed="${e.onHud}">` +
          `<span>${escapeHtml(t(e.onHud ? "journal.hud.on" : "journal.hud.off"))}</span></button>` +
          "</div>"
        : "") +
      "</article>"
    );
  }

  /** Count only printed when need > 1 — the tick already says 0/1. */
  private stepHtml(o: JournalObjective): string {
    const done = o.have >= o.need;
    return (
      `<li class="${done ? "ok" : ""}">` +
      `<i class="tk">${done ? CHECK_ICON : ""}</i>` +
      `<span>${this.stepText(o)}</span>` +
      (o.need > 1 ? `<b>${o.have}/${o.need}</b>` : "") +
      "</li>"
    );
  }

  /**
   * The objective's prose with each hoverable NAME wrapped in a `data-tip` span
   * (issue #246). The names come from the quest's structured trigger, resolved
   * through the same language table the prose was — so this is a find of a
   * known display name, never a parse. A name the line does not contain gets no
   * span, which is correct: prose that names nothing structured has no hover.
   */
  private stepText(o: JournalObjective): string {
    const text = o.text;
    const lower = text.toLowerCase();
    const spans: { start: number; end: number; tip: string }[] = [];
    for (const h of o.hovers ?? []) {
      const at = lower.indexOf(h.name.toLowerCase());
      if (at < 0 || h.name.length === 0) {
        continue;
      }
      if (spans.some((s) => at < s.end && at + h.name.length > s.start)) {
        continue;
      }
      spans.push({ start: at, end: at + h.name.length, tip: h.tip });
    }
    if (spans.length === 0) {
      return escapeHtml(text);
    }
    spans.sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0;
    for (const s of spans) {
      out += escapeHtml(text.slice(at, s.start));
      out += `<span class="tipw" data-tip="${escapeHtml(s.tip)}">${escapeHtml(text.slice(s.start, s.end))}</span>`;
      at = s.end;
    }
    return out + escapeHtml(text.slice(at));
  }

  /** For the host: a portrait finished baking while a tip may be up. */
  patchPortrait(speciesId: string, url: string): void {
    this.tip.patchIcon(speciesId, url);
  }

  private tipAt(target: EventTarget | null): TipContent | null {
    const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
    const key = el?.dataset.tip;
    return key ? (this.hooks.tipFor?.(key) ?? null) : null;
  }

  private onPointerOver = (ev: PointerEvent): void => {
    const e = this.tipAt(ev.target);
    if (e) {
      this.tip.show(e, ev.clientX, ev.clientY);
    } else {
      this.tip.hide();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.tip.visible) {
      this.tip.move(ev.clientX, ev.clientY);
    }
  };

  private onPointerOut = (ev: PointerEvent): void => {
    if (!this.tipAt(ev.relatedTarget)) {
      this.tip.hide();
    }
  };

  private showTab(tab: JournalTab): void {
    this.tab = tab;
    this.pendingFocus = `[data-tab="${tab}"]`;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || !this.el) {
      return;
    }
    if (target.classList.contains("bs-scrim")) {
      this.close("click");
      return;
    }
    const btn = target.closest("button") as HTMLButtonElement | null;
    if (!btn) {
      return;
    }

    if (btn.dataset.act === "close") {
      this.close("click");
      return;
    }

    const tab = btn.dataset.tab as JournalTab | undefined;
    if (tab !== undefined) {
      this.showTab(tab);
      return;
    }

    const hud = btn.dataset.hud;
    if (hud !== undefined) {
      this.hooks.onToggleHud(hud);
      if (!this.el) {
        return;
      } // the host may have closed us from inside the hook
      this.pendingFocus = `[data-hud="${CSS.escape(hud)}"]`;
      this.render();
    }
  };

  /** Escape and `KeyJ` are NOT read here — the host owns those edges for all devices. */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.el) {
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }
    switch (ev.key) {
      case "ArrowRight":
        if (!this.stepStrip(1)) {
          this.moveFocus(1);
        }
        ev.preventDefault();
        break;
      case "ArrowLeft":
        if (!this.stepStrip(-1)) {
          this.moveFocus(-1);
        }
        ev.preventDefault();
        break;
      case "ArrowDown":
        ev.preventDefault();
        this.moveFocus(1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        this.moveFocus(-1);
        break;
      // Enter left to the platform — every control is a real button.
      default:
        break;
    }
  };

  private stepStrip(dir: -1 | 1): boolean {
    const strip = (document.activeElement as HTMLElement | null)?.closest?.(".strip");
    if (!strip) {
      return false;
    }
    const i = TABS.findIndex((tb) => tb.id === this.tab);
    this.showTab(TABS[(i + dir + TABS.length) % TABS.length].id);
    return true;
  }

  moveFocus(d: number): void {
    if (!this.focusables.length) {
      return;
    }
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    const n = this.focusables.length;
    this.focusIdx = (from + d + n) % n;
    this.focusables[this.focusIdx].focus();
  }

  /** For a host driving this from `Input`. */
  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  /** See `InventoryPanel.pollPad`. */
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
    const stickX = pad.axes[0] ?? 0;
    const dirX = stickX < -0.5 ? -1 : stickX > 0.5 ? 1 : 0;
    if (dirX === 0) {
      this.padLatchX = false;
    }

    let moveY = 0;
    if (this.padEdge[12]) {
      moveY = -1;
    } else if (this.padEdge[13]) {
      moveY = 1;
    } else if (dirY !== 0 && !this.padLatchY) {
      moveY = dirY;
      this.padLatchY = true;
    }
    if (moveY) {
      this.moveFocus(moveY);
    }

    let moveX = 0;
    if (this.padEdge[14]) {
      moveX = -1;
    } else if (this.padEdge[15]) {
      moveX = 1;
    } else if (dirX !== 0 && !this.padLatchX) {
      moveX = dirX;
      this.padLatchX = true;
    }
    if (moveX && !this.stepStrip(moveX as -1 | 1)) {
      this.moveFocus(moveX);
    }

    // B is NOT read — GamepadControls taps a virtual Escape, routed to `onEscape`.
    if (this.padEdge[0]) {
      this.activate();
    }
  };
}

const EMPTY_KEYS: Record<JournalTab, StringKey> = {
  active: "journal.empty.active",
  available: "journal.empty.available",
  completed: "journal.empty.completed",
};

function kbd(s: string): string {
  return `<kbd>${escapeHtml(s)}</kbd>`;
}
