import { t } from '../i18n';
import type { ItemKind, ItemRarity } from '../core/types';
import { injectStyles } from './styles';
import { CLOSE_ICON } from './icons';
import { isWeaponIcon, weaponIconStyle } from './weapon-icons';

/**
 * THE INVENTORY — what you are carrying, what you have equipped, and the four
 * things you may do to a thing you own.
 *
 * Issue #74. Opened with `I`, closed with `I` or Escape, and a MODAL in the F1
 * sense: main.ts freezes the hero while it is up, because a player who stopped
 * to read a blueprint must not have walked into a lake doing it.
 *
 * THIS PANEL KNOWS NO GAME RULES, and that is the whole of its design. It does
 * not know that a quest item cannot be dropped, that a scythe is stronger than a
 * dagger, or that equipping a beast swaps the one that was there. It is handed
 * an `InventoryModel` — rows with a name, an icon, some stats and a LIST OF
 * ACTIONS the host is willing to accept — and it reports which button was
 * pressed on which row. Every rule stays in main.ts beside the state it governs,
 * which is the same split ui/settings.ts draws (the panel owns the screen, the
 * host owns what a click means) and the same one content/types.ts argues for
 * with its factories.
 *
 * The consequence worth stating: adding a rule is an edit to the host, and
 * adding a KIND of thing you can do to an item is an edit to `InvAction` plus
 * one label. Neither is an edit to the layout.
 *
 * WHY IT IS ITS OWN FILE AND NOT PART OF THE HUD. By ui/pause.ts's rule it
 * belongs in ui/index.ts — it is a view of GAME STATE, like the shop, not of the
 * session. What it does NOT share with the shop is its input: this needs a
 * roving cursor, a pad poll and a grid to walk, which is ui/pause.ts's machinery
 * rather than the HUD's. So it takes the HUD's LOOK (`.bs-glass`, `.bs-scrim`,
 * `.bs-shop-x`) and the pause menu's INPUT, and lives beside neither's file
 * rather than doubling the length of one of them.
 */

/** What a button on a row asks the host to do. Labels are in `ACTION_KEYS`. */
export type InvAction =
  | 'equip' | 'unequip' | 'use' | 'salvage' | 'drop' | 'forge'
  | 'setLead' | 'setSupport';

const ACTION_KEYS: Record<InvAction, 'inv.equip' | 'inv.unequip' | 'inv.use' | 'inv.salvage'
  | 'inv.drop' | 'inv.forge' | 'inv.setLead' | 'inv.setSupport'> = {
  equip: 'inv.equip',
  unequip: 'inv.unequip',
  use: 'inv.use',
  salvage: 'inv.salvage',
  drop: 'inv.drop',
  forge: 'inv.forge',
  setLead: 'inv.setLead',
  setSupport: 'inv.setSupport',
};

/**
 * Which actions are the LOUD one on a row.
 *
 * A row usually offers two or three buttons and exactly one of them is what the
 * player came to press; the rest are housekeeping. Salvage and drop are never
 * that button — they destroy something — so they are never the primary however
 * few buttons a row has.
 */
const DESTRUCTIVE: ReadonlySet<InvAction> = new Set<InvAction>(['salvage', 'drop']);

/** One label/value pair under the blurb. Both are already display strings. */
export interface InvStat {
  label: string;
  value: string;
}

export interface InvEntry {
  /** Item id, or `beast:<species>`. Round-tripped to the host untouched. */
  id: string;
  kind: ItemKind;
  /** Display name, already plural-resolved for `count` by the host. */
  name: string;
  /** How many are held. 1 for anything that does not stack; shown from 2 up. */
  count: number;
  /** Fallback tint, and the slot's glow. An icon covers it when there is one. */
  color: number;
  /** A tile name in the weapon atlas, or absent for a coloured glyph. */
  icon?: string;
  rarity?: ItemRarity;
  /** The paragraph in the detail pane. */
  description?: string;
  stats?: readonly InvStat[];
  /** Draws the row as in-use, and is what the gear slots point at. */
  equipped?: boolean;
  /** One quiet line under the buttons — why an action is missing, usually. */
  note?: string;
  actions?: readonly InvAction[];
}

/** One of the three gear slots along the top. */
export interface GearSlotView {
  slot: 'weapon' | 'primary' | 'support';
  /** The entry filling it, or null for an empty slot. */
  entry: InvEntry | null;
}

export interface InventoryModel {
  gear: readonly GearSlotView[];
  entries: readonly InvEntry[];
}

export interface InventoryHooks {
  /** Rebuild the model — called on open and after every action. */
  model: () => InventoryModel;
  /** A button was pressed. The host mutates state; the panel re-reads `model`. */
  onAction: (id: string, action: InvAction) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * The tab strip, and it is a FILTER rather than a set of pages: `null` is "all",
 * and the rest name a kind. Currency is missing on purpose — the Cubloon total
 * is the HUD's pill and has no stack to show.
 */
const TABS: readonly { id: ItemKind | null; key: string }[] = [
  { id: null, key: 'inv.tab.all' },
  { id: 'beast', key: 'inv.tab.beast' },
  { id: 'weapon', key: 'inv.tab.weapon' },
  { id: 'blueprint', key: 'inv.tab.blueprint' },
  { id: 'potion', key: 'inv.tab.potion' },
  { id: 'stackable', key: 'inv.tab.stackable' },
  { id: 'quest', key: 'inv.tab.quest' },
];

/**
 * How many slots to a row. Read by the keyboard's up/down, which is the only
 * reason the panel has to know: the CSS lays the grid out with `repeat(N, …)`
 * from the same constant, so the two cannot disagree about what "the row below"
 * means. Changing it here changes both.
 */
export const INV_COLS = 6;

/** Same list ui/settings.ts uses, and for the same two reasons. */
const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const hexColor = (c: number): string => '#' + c.toString(16).padStart(6, '0');

const RARITY_KEYS: Record<ItemRarity, 'inv.rarity.common' | 'inv.rarity.rare' | 'inv.rarity.legendary'> = {
  common: 'inv.rarity.common',
  rare: 'inv.rarity.rare',
  legendary: 'inv.rarity.legendary',
};

export class InventoryPanel {
  private el: HTMLDivElement | null = null;
  private tab: ItemKind | null = null;
  /** Which row the detail pane is showing, by id. Survives a tab change. */
  private selected: string | null = null;
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private pendingFocus: string | null = null;
  private padRaf = 0;
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padLatchY = false;
  private padLatchX = false;

  constructor(private hooks: InventoryHooks) {
    injectStyles();
  }

  get isOpen(): boolean { return this.el !== null; }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  open(): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'bs-inv';
    el.innerHTML = '<div class="bs-scrim"></div><div class="pane bs-glass"></div>';
    this.el = el;
    document.body.appendChild(el);
    el.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKeyDown, true);
    this.render();
    this.pollPad();
    requestAnimationFrame(() => el.classList.add('open'));
    this.hooks.onOpen?.();
  }

  close(): void {
    if (!this.el) return;
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    window.removeEventListener('keydown', this.onKeyDown, true);
    // A button still down when this closes would read as a fresh press next
    // time — the same reason ui/pause.ts clears it here rather than on open.
    this.padDown.fill(0);
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.hooks.onClose?.();
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  /**
   * The host saw a cancel (Escape, the pad's B, the touch MENU button). Returns
   * whether this panel spent it — the same contract `PauseMenu.onEscape` has,
   * and it is why main.ts can keep one "close the topmost thing" rule.
   */
  onEscape(): boolean {
    if (!this.el) return false;
    this.close();
    return true;
  }

  dispose(): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  /**
   * Rebuild from the host's model.
   *
   * The WHOLE panel, every time, rather than patching the row that changed —
   * a salvage removes a row, an equip moves an entry into a gear slot and takes
   * a beast out of one, and a use empties a stack: there is no action here whose
   * effect is local to the element it was pressed on. `pendingFocus` is what
   * makes that cheap enough to be right; see the note in ui/pause.ts.
   */
  private render(): void {
    const el = this.el;
    if (!el) return;
    const model = this.hooks.model();
    const pane = el.querySelector('.pane') as HTMLDivElement;

    const rows = this.tab === null
      ? model.entries
      : model.entries.filter((e) => e.kind === this.tab);

    // A selection that the last action removed (salvaged, dropped, drunk) falls
    // back to the first row rather than leaving the detail pane pointing at
    // nothing — and to null when the tab is empty.
    let sel = rows.find((e) => e.id === this.selected) ?? null;
    if (!sel) sel = rows[0] ?? null;
    this.selected = sel?.id ?? null;

    pane.innerHTML =
      `<div class="head"><h2>${escapeHtml(t('inv.title'))}</h2></div>` +
      this.gearHtml(model.gear) +
      this.tabsHtml() +
      '<div class="body">' +
        `<div class="grid" style="--cols:${INV_COLS}">${
          rows.length
            ? rows.map((e) => this.slotHtml(e)).join('')
            : `<p class="empty">${escapeHtml(t('inv.empty'))}</p>`
        }</div>` +
        `<div class="detail">${this.detailHtml(sel)}</div>` +
      '</div>' +
      `<div class="foot">${t('inv.foot', { key: kbd('I'), esc: kbd('Esc') })}</div>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.type = 'button';
    closeBtn.dataset.act = 'close';
    closeBtn.innerHTML = CLOSE_ICON;
    (pane.querySelector('.head') as HTMLElement).appendChild(closeBtn);

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  private gearHtml(gear: readonly GearSlotView[]): string {
    return '<div class="gear">' +
      `<span class="gl">${escapeHtml(t('inv.gear'))}</span>` +
      gear.map((g) => {
        const e = g.entry;
        const label = t(
          g.slot === 'weapon' ? 'inv.slot.weapon'
          : g.slot === 'primary' ? 'inv.slot.primary' : 'inv.slot.support',
        );
        // A filled slot is a BUTTON that selects the thing in it, so a player
        // who wants to swap their weapon starts from the weapon they have.
        // Empty is a plain div: there is nothing to select.
        const inner =
          `<span class="gs-ic">${e ? this.iconHtml(e) : ''}</span>` +
          `<span class="gs-t"><b>${escapeHtml(label)}</b>` +
          `<span>${escapeHtml(e ? e.name : t('inv.slot.empty'))}</span></span>`;
        return e
          ? `<button class="gs full" type="button" data-sel="${escapeHtml(e.id)}"` +
            ` style="--el:${hexColor(e.color)}">${inner}</button>`
          : `<div class="gs">${inner}</div>`;
      }).join('') +
      '</div>';
  }

  private tabsHtml(): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return `<button class="chip tab${on ? ' on' : ''}" type="button" role="tab"` +
        ` data-tab="${tb.id ?? 'all'}" aria-selected="${on}"${on ? '' : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.key as 'inv.tab.all'))}</button>`;
    }).join('')}</div>`;
  }

  /** The picture in a slot: an atlas tile when there is one, else a lozenge. */
  private iconHtml(e: InvEntry): string {
    if (e.icon && isWeaponIcon(e.icon)) {
      return `<i class="ic" style="${weaponIconStyle(e.icon)}"></i>`;
    }
    return `<i class="ic blob" style="--el:${hexColor(e.color)}"></i>`;
  }

  private slotHtml(e: InvEntry): string {
    const cls = ['slot'];
    if (e.rarity) cls.push(`r-${e.rarity}`);
    if (e.equipped) cls.push('on');
    if (e.id === this.selected) cls.push('sel');
    return `<button class="${cls.join(' ')}" type="button" data-sel="${escapeHtml(e.id)}"` +
      ` style="--el:${hexColor(e.color)}" title="${escapeHtml(e.name)}">` +
      this.iconHtml(e) +
      (e.count > 1 ? `<span class="n">${e.count}</span>` : '') +
      `<span class="nm">${escapeHtml(e.name)}</span>` +
      '</button>';
  }

  private detailHtml(e: InvEntry | null): string {
    if (!e) return `<p class="pick">${escapeHtml(t('inv.pick'))}</p>`;
    const acts = e.actions ?? [];
    // The primary is the first action that is not a way of destroying the item
    // — see DESTRUCTIVE. A row of only destructive actions gets no primary at
    // all, which is the intended emphasis rather than a gap.
    const primary = acts.find((a) => !DESTRUCTIVE.has(a));
    return `<div class="dh" style="--el:${hexColor(e.color)}">` +
        `<span class="dic">${this.iconHtml(e)}</span>` +
        `<div><h3>${escapeHtml(e.name)}</h3>` +
        (e.rarity ? `<span class="rar r-${e.rarity}">${escapeHtml(t(RARITY_KEYS[e.rarity]))}</span>` : '') +
        '</div></div>' +
      (e.description ? `<p>${escapeHtml(e.description)}</p>` : '') +
      (e.stats?.length
        ? `<div class="bs-chips">${e.stats.map((s) =>
            `<span class="bs-chip">${escapeHtml(s.label)} <b>${escapeHtml(s.value)}</b></span>`).join('')}</div>`
        : '') +
      (acts.length
        ? `<div class="acts">${acts.map((a) =>
            `<button class="bs-buy${a === primary ? '' : ' ghost'}${DESTRUCTIVE.has(a) ? ' danger' : ''}"` +
            ` type="button" data-do="${a}">${escapeHtml(t(ACTION_KEYS[a]))}</button>`).join('')}</div>`
        : '') +
      (e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : '');
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !this.el) return;
    // The scrim IS a way out here, unlike the pause menu: the world behind is
    // still the thing you came for, which is the shop's argument exactly.
    if (target.classList.contains('bs-scrim')) { this.close(); return; }
    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    if (btn.dataset.act === 'close') { this.close(); return; }

    const tab = btn.dataset.tab;
    if (tab !== undefined) { this.showTab(tab === 'all' ? null : tab as ItemKind); return; }

    const sel = btn.dataset.sel;
    if (sel !== undefined) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
      return;
    }

    const act = btn.dataset.do as InvAction | undefined;
    if (act && this.selected) {
      const id = this.selected;
      this.hooks.onAction(id, act);
      // The panel may have been closed by the host from inside the action —
      // nothing does today, and a render into a removed element would be the
      // silent kind of wrong if one ever did.
      if (!this.el) return;
      this.pendingFocus = `[data-do="${act}"]`;
      this.render();
    }
  };

  private showTab(tab: ItemKind | null): void {
    this.tab = tab;
    this.pendingFocus = `[data-tab="${tab ?? 'all'}"]`;
    this.render();
  }

  /**
   * Arrows walk the panel; Enter and Space are the platform's, because every
   * control here is a real `<button>`.
   *
   * ESCAPE IS NOT HERE, for the reason ui/pause.ts gives at length: it reaches
   * this panel from three devices and only one of them is a DOM key event, so
   * the host owns that edge for all three and this listener owns only what a
   * keyboard alone can send. `KeyI` is the same case and is also the host's.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.el) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': if (!this.stepStrip(1)) this.moveFocus(1); e.preventDefault(); break;
      case 'ArrowLeft': if (!this.stepStrip(-1)) this.moveFocus(-1); e.preventDefault(); break;
      // Up/down move a GRID ROW at a time inside the grid and one stop
      // everywhere else, which is what makes a wall of slots walkable without
      // giving the panel a second, private notion of where things are: the row
      // width is INV_COLS and the stylesheet lays the grid out from it.
      case 'ArrowDown': e.preventDefault(); this.moveFocus(this.rowStep(1)); break;
      case 'ArrowUp': e.preventDefault(); this.moveFocus(this.rowStep(-1)); break;
      default: break;
    }
  };

  /** Left/right on the tab strip changes the FILTER rather than walking chips. */
  private stepStrip(dir: -1 | 1): boolean {
    const strip = (document.activeElement as HTMLElement | null)?.closest?.('.strip');
    if (!strip) return false;
    const i = TABS.findIndex((tb) => tb.id === this.tab);
    this.showTab(TABS[(i + dir + TABS.length) % TABS.length].id);
    return true;
  }

  private rowStep(dir: -1 | 1): number {
    const here = document.activeElement as HTMLElement | null;
    return here?.classList.contains('slot') ? INV_COLS * dir : dir;
  }

  moveFocus(d: number): void {
    if (!this.focusables.length) return;
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    // CLAMPED rather than wrapped, and only for a multi-stop jump: a down-arrow
    // on the last half-row of slots should land on the last slot, not spring
    // back to the tab strip. A single step still wraps, so a pad can circle.
    const n = this.focusables.length;
    let next = from + d;
    if (Math.abs(d) > 1) next = Math.min(n - 1, Math.max(0, next));
    else next = (next + n) % n;
    this.focusIdx = next;
    this.focusables[this.focusIdx].focus();
    // Selecting as the cursor passes is what makes the detail pane follow a pad
    // without a press — but only for a SLOT, or arrowing onto Salvage would
    // change what Salvage is pointed at.
    const el = this.focusables[this.focusIdx];
    const sel = el.dataset.sel;
    if (sel !== undefined && el.classList.contains('slot') && sel !== this.selected) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
    }
  }

  /** Enter/Space on the focused control, for a host driving this from `Input`. */
  activate(): void {
    (document.activeElement as HTMLButtonElement | null)?.click();
  }

  /** See the note on `PauseMenu.pollPad` — same poll, same reasons. */
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
    if (moveY) this.moveFocus(this.rowStep(moveY as -1 | 1));

    let moveX = 0;
    if (this.padEdge[14]) moveX = -1;
    else if (this.padEdge[15]) moveX = 1;
    else if (dirX !== 0 && !this.padLatchX) { moveX = dirX; this.padLatchX = true; }
    if (moveX && !this.stepStrip(moveX as -1 | 1)) this.moveFocus(moveX);

    // A activates. B is NOT read: GamepadControls already taps a virtual Escape
    // for it while a modal is up, and the host routes that into `onEscape`.
    if (this.padEdge[0]) this.activate();
  };
}

/**
 * Same key cap markup the HUD and the F1 sheet use — `<kbd>`, styled by the one
 * rule in ui/styles.ts that names both roots. Restated here rather than imported
 * from ui/index.ts so this panel does not pull the whole HUD in for one span.
 */
function kbd(s: string): string {
  return `<kbd>${escapeHtml(s)}</kbd>`;
}
