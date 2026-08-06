import { t, type StringKey } from '../i18n';
import { injectStyles } from './styles';
import { CHECK_ICON, CLOSE_ICON } from './icons';

/**
 * THE QUEST JOURNAL — what you were asked to do, how far into it you are, and
 * which of it you want the HUD to keep reminding you about.
 *
 * Issue #98. Opened with `J`, closed with the same or with Escape, and a MODAL
 * in the inventory's sense: main.ts freezes the hero while it is up, because a
 * player who stopped to read their objectives must not have walked into a lake
 * doing it. It releases pointer lock for the same reason the inventory does —
 * every row in here has a button on it.
 *
 * A RIGHT-HAND DOCK, sharing the inventory's geometry down to the slide-in, and
 * that similarity is the feature: these are the two panels a player opens with a
 * single key while standing in the world, and a journal that arrived from a
 * different edge with a different corner radius would read as a different
 * program. Below 720px it goes FULL SCREEN — a dock is a dock because there is a
 * world worth leaving visible beside it, and on a phone there is not.
 *
 * THIS PANEL KNOWS NO QUEST RULES. It is handed a `JournalModel` — rows already
 * resolved to display strings, with their objectives counted and their rewards
 * named — and reports one thing back: that the player asked to flip whether a
 * quest is on the HUD. It does not know what `ContentText` is, that progress is
 * keyed `<quest>/<objective>`, or that "available" is a condition rather than a
 * stored status. main.ts owns all of that, the same way it owns what dropping a
 * potion on the weapon slot means.
 *
 * ONE SCROLLING COLUMN OF CARDS, not a master/detail split. A quest is a name, a
 * paragraph, a short list of steps and a couple of rewards — the whole of it
 * fits in a card, and a detail pane would spend a third of a dock's width to
 * show what was already on screen. It is also what makes the answer to "what am
 * I doing" one glance rather than one glance per row.
 *
 * THE HUD TOGGLE IS PER QUEST AND LIVES HERE because this is the only screen
 * that lists quests at all. Its state is a content flag (see `hudFlag` in
 * main.ts), so it rides along in a save and survives a package being unloaded
 * and loaded again.
 */

/** See `InvCloseBy` in ui/inventory.ts — same three values, same reasons. */
export type JournalCloseBy = 'escape' | 'hotkey' | 'click';

/** Which shelf a quest is on. The tabs, and the order they are shown in. */
export type JournalTab = 'active' | 'available' | 'completed';

const TABS: readonly { id: JournalTab; key: StringKey }[] = [
  { id: 'active', key: 'journal.tab.active' },
  { id: 'available', key: 'journal.tab.available' },
  { id: 'completed', key: 'journal.tab.completed' },
];

/** One step, already counted by the host. `need` is 1 for a boolean objective. */
export interface JournalObjective {
  text: string;
  have: number;
  need: number;
}

/** One reward line, already named and formatted by the host. */
export interface JournalReward {
  label: string;
  value: string;
}

export interface JournalEntry {
  id: string;
  /** Display name, already resolved out of `ContentText`. */
  name: string;
  description?: string;
  category: 'main' | 'side';
  tab: JournalTab;
  /** A story grouping, shown as a quiet line. A LABEL — see content/types/quest.ts. */
  arc?: string;
  /** Who gave it, and where — display names, not ids. */
  giver?: string;
  location?: string;
  objectives: readonly JournalObjective[];
  rewards: readonly JournalReward[];
  /** Whether the HUD is currently showing this one. Only meaningful when active. */
  onHud: boolean;
}

export interface JournalModel {
  entries: readonly JournalEntry[];
}

export interface JournalHooks {
  /** Rebuild the model — called on open, on refresh, and after every toggle. */
  model: () => JournalModel;
  /** The player asked to flip whether this quest is on the HUD. */
  onToggleHud: (id: string) => void;
  onOpen?: () => void;
  onClose?: (by: JournalCloseBy) => void;
}

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class JournalPanel {
  private el: HTMLDivElement | null = null;
  private tab: JournalTab = 'active';
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

  get isOpen(): boolean { return this.el !== null; }

  /** Which shelf is showing, for the probe. */
  get activeTab(): JournalTab { return this.tab; }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  open(): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'bs-journal';
    el.innerHTML =
      '<div class="bs-scrim"></div>' +
      '<aside class="pane bs-glass"></aside>';
    this.el = el;
    document.body.appendChild(el);
    el.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown, true);
    this.render();
    this.pollPad();
    requestAnimationFrame(() => el.classList.add('open'));
    this.hooks.onOpen?.();
  }

  close(by: JournalCloseBy = 'click'): void {
    if (!this.el) return;
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.hooks.onClose?.(by);
  }

  /** The host's `J`. */
  toggle(): void {
    if (this.el) this.close('hotkey');
    else this.open();
  }

  /**
   * Re-read the model, if the panel is up. Unlike the inventory's, this one is
   * NOT a courtesy: a quest can advance while the journal is open — an objective
   * counted by a timer, a package loading, the dev console starting one — and
   * the panel is the screen that claims to say where you are.
   */
  refresh(): void {
    if (this.el) this.render();
  }

  /** See `InventoryPanel.onEscape` — returns whether this panel SPENT the press. */
  onEscape(): boolean {
    if (!this.el) return false;
    this.close('escape');
    return true;
  }

  dispose(): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  private render(): void {
    const el = this.el;
    if (!el) return;
    const model = this.hooks.model();
    const pane = el.querySelector('.pane') as HTMLElement;
    const list = model.entries.filter((e) => e.tab === this.tab);

    pane.innerHTML =
      `<div class="head"><h2>${escapeHtml(t('journal.title'))}</h2></div>` +
      this.tabsHtml(model) +
      `<div class="list">${
        list.length
          ? list.map((e) => this.cardHtml(e)).join('')
          : `<p class="none">${escapeHtml(t(EMPTY_KEYS[this.tab]))}</p>`
      }</div>`;

    // The keys that close it, printed beside the X — the inventory's rule.
    const head = pane.querySelector('.head') as HTMLElement;
    head.insertAdjacentHTML('beforeend', `<span class="cap">${kbd('J')}${kbd('Esc')}</span>`);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.type = 'button';
    closeBtn.dataset.act = 'close';
    closeBtn.innerHTML = CLOSE_ICON;
    head.appendChild(closeBtn);

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  /**
   * The three shelves, each carrying its COUNT. The number is the reason the
   * tabs are worth their row: "Completed 12" is a different sentence from
   * "Completed", and it is the one a player opening a journal came to read.
   */
  private tabsHtml(model: JournalModel): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      const n = model.entries.reduce((sum, e) => sum + (e.tab === tb.id ? 1 : 0), 0);
      return `<button class="chip tab${on ? ' on' : ''}" type="button" role="tab"` +
        ` data-tab="${tb.id}" aria-selected="${on}"${on ? '' : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.key))}<b>${n}</b></button>`;
    }).join('')}</div>`;
  }

  /**
   * One quest, whole. The order is the order a player asks the questions in:
   * what is it (badge and name), why (description), what do I do (objectives),
   * what do I get (rewards), and only then the control.
   *
   * THE HUD TOGGLE IS ONLY ON AN ACTIVE QUEST, because it is the only shelf the
   * HUD draws from. On the other two it would be a switch wired to nothing —
   * see `hudRows` in main.ts, which filters on the same rule from the other end.
   */
  private cardHtml(e: JournalEntry): string {
    const done = e.objectives.every((o) => o.have >= o.need);
    const meta = [e.arc, e.giver, e.location].filter((s): s is string => !!s);
    return `<article class="q c-${e.category}${done ? ' done' : ''}" data-quest="${escapeHtml(e.id)}">` +
      '<div class="q-h">' +
        `<span class="badge">${escapeHtml(t(e.category === 'main' ? 'journal.main' : 'journal.side'))}</span>` +
        `<h3>${escapeHtml(e.name)}</h3>` +
      '</div>' +
      (meta.length ? `<p class="q-m">${meta.map(escapeHtml).join(' · ')}</p>` : '') +
      (e.description ? `<p class="q-d">${escapeHtml(e.description)}</p>` : '') +
      (e.objectives.length
        ? `<ul class="steps">${e.objectives.map((o) => this.stepHtml(o)).join('')}</ul>`
        : '') +
      (e.rewards.length
        ? `<div class="bs-chips">${e.rewards.map((r) =>
            `<span class="bs-chip">${escapeHtml(r.label)} <b>${escapeHtml(r.value)}</b></span>`).join('')}</div>`
        : '') +
      (e.tab === 'active'
        ? '<div class="q-f">' +
          `<button class="bs-buy ghost${e.onHud ? ' on' : ''}" type="button"` +
          ` data-hud="${escapeHtml(e.id)}" aria-pressed="${e.onHud}">` +
          `<span>${escapeHtml(t(e.onHud ? 'journal.hud.on' : 'journal.hud.off'))}</span></button>` +
          '</div>'
        : '') +
      '</article>';
  }

  /**
   * A step. A count is only PRINTED when there is more than one to do — "Speak
   * with Gain 0/1" is a progress bar for a conversation, and the tick beside it
   * already says the same thing.
   */
  private stepHtml(o: JournalObjective): string {
    const done = o.have >= o.need;
    return `<li class="${done ? 'ok' : ''}">` +
      `<i class="tk">${done ? CHECK_ICON : ''}</i>` +
      `<span>${escapeHtml(o.text)}</span>` +
      (o.need > 1 ? `<b>${o.have}/${o.need}</b>` : '') +
      '</li>';
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private showTab(tab: JournalTab): void {
    this.tab = tab;
    this.pendingFocus = `[data-tab="${tab}"]`;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || !this.el) return;
    // The scrim is a way out — the inventory's bargain, and for its reason: the
    // world behind it is still the thing you came for.
    if (target.classList.contains('bs-scrim')) { this.close('click'); return; }
    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    if (btn.dataset.act === 'close') { this.close('click'); return; }

    const tab = btn.dataset.tab as JournalTab | undefined;
    if (tab !== undefined) { this.showTab(tab); return; }

    const hud = btn.dataset.hud;
    if (hud !== undefined) {
      this.hooks.onToggleHud(hud);
      if (!this.el) return;   // the host may have closed us from inside the hook
      this.pendingFocus = `[data-hud="${CSS.escape(hud)}"]`;
      this.render();
    }
  };

  /**
   * Arrows walk the panel and Enter presses the focused control. ESCAPE IS NOT
   * HERE, for the reason ui/inventory.ts gives at length: it reaches this panel
   * from three devices and only one of them is a DOM key event, so the host owns
   * that edge for all three. `KeyJ` is the same case.
   */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.el) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    switch (ev.key) {
      case 'ArrowRight': if (!this.stepStrip(1)) this.moveFocus(1); ev.preventDefault(); break;
      case 'ArrowLeft': if (!this.stepStrip(-1)) this.moveFocus(-1); ev.preventDefault(); break;
      case 'ArrowDown': ev.preventDefault(); this.moveFocus(1); break;
      case 'ArrowUp': ev.preventDefault(); this.moveFocus(-1); break;
      // Enter is left to the platform: every control in here is a real button,
      // so the browser's own activation already does the right thing.
      default: break;
    }
  };

  private stepStrip(dir: -1 | 1): boolean {
    const strip = (document.activeElement as HTMLElement | null)?.closest?.('.strip');
    if (!strip) return false;
    const i = TABS.findIndex((tb) => tb.id === this.tab);
    this.showTab(TABS[(i + dir + TABS.length) % TABS.length].id);
    return true;
  }

  moveFocus(d: number): void {
    if (!this.focusables.length) return;
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    const n = this.focusables.length;
    this.focusIdx = (from + d + n) % n;
    this.focusables[this.focusIdx].focus();
  }

  /** Enter/A on the focused control, for a host driving this from `Input`. */
  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  /** See the note on `InventoryPanel.pollPad` — same poll, same reasons. */
  private pollPad = (): void => {
    if (!this.el) return;
    this.padRaf = requestAnimationFrame(this.pollPad);

    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads?.() ?? []) {
        if (p?.connected) { pad = p; break; }
      }
    } catch {
      return;
    }
    if (!pad) { this.padDown.fill(0); return; }

    const n = Math.min(pad.buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const now = pad.buttons[i]?.pressed ? 1 : 0;
      this.padEdge[i] = now === 1 && this.padDown[i] === 0 ? 1 : 0;
      this.padDown[i] = now;
    }

    const stickY = pad.axes[1] ?? 0;
    const dirY = stickY < -0.5 ? -1 : stickY > 0.5 ? 1 : 0;
    if (dirY === 0) this.padLatchY = false;
    const stickX = pad.axes[0] ?? 0;
    const dirX = stickX < -0.5 ? -1 : stickX > 0.5 ? 1 : 0;
    if (dirX === 0) this.padLatchX = false;

    let moveY = 0;
    if (this.padEdge[12]) moveY = -1;
    else if (this.padEdge[13]) moveY = 1;
    else if (dirY !== 0 && !this.padLatchY) { moveY = dirY; this.padLatchY = true; }
    if (moveY) this.moveFocus(moveY);

    let moveX = 0;
    if (this.padEdge[14]) moveX = -1;
    else if (this.padEdge[15]) moveX = 1;
    else if (dirX !== 0 && !this.padLatchX) { moveX = dirX; this.padLatchX = true; }
    if (moveX && !this.stepStrip(moveX as -1 | 1)) this.moveFocus(moveX);

    // A activates. B is NOT read — GamepadControls taps a virtual Escape for it
    // while a modal is up, and the host routes that into `onEscape`.
    if (this.padEdge[0]) this.activate();
  };
}

const EMPTY_KEYS: Record<JournalTab, StringKey> = {
  active: 'journal.empty.active',
  available: 'journal.empty.available',
  completed: 'journal.empty.completed',
};

/** The HUD's key-cap markup, restated for the reason ui/inventory.ts restates it. */
function kbd(s: string): string {
  return `<kbd>${escapeHtml(s)}</kbd>`;
}
