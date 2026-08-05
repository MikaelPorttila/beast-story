import { t } from '../i18n';
import type { BeastSpecies, ItemKind, ItemRarity } from '../core/types';
import { injectStyles } from './styles';
import { CLOSE_ICON } from './icons';
import { isWeaponIcon, weaponIconStyle } from './weapon-icons';
import { InventoryStage } from './inventory-stage';

/**
 * THE INVENTORY — what you are carrying, who is standing with you, and the
 * things you may do to something you own.
 *
 * Issue #74. Opened with `I` (View/Create on a pad), closed with the same, and a
 * MODAL in the F1 sense: main.ts freezes the hero while it is up, because a
 * player who stopped to read a blueprint must not have walked into a lake doing
 * it. It RELEASES POINTER LOCK, which is the shop's bargain rather than the F1
 * sheet's — this is a panel you click, drag in, and right-click.
 *
 * A RIGHT-HAND DOCK, FULL HEIGHT, and that is not a decoration. The top of it is
 * a live 3D stage (ui/inventory-stage.ts) showing the hero with his two beasts,
 * each standing over the gear slot that holds them — which only reads as a
 * PARTY if the panel is tall enough to give the figures room. A centred box wide
 * enough for six columns and tall enough for that covers the world it is a view
 * of; docked right, half the frame is still the place you are standing in.
 *
 * THIS PANEL KNOWS NO GAME RULES, and that survived the redesign intact. It is
 * handed an `InventoryModel` — rows with a name, an icon, some stats and a LIST
 * OF ACTIONS the host is willing to accept — and reports which one was asked
 * for. It does not know that a quest item cannot be dropped or that equipping a
 * beast pushes another one sideways. What it added here is a MAPPING, which is a
 * different thing: dropping something on the weapon slot means `equip`, and the
 * slot refuses the drag unless the host already listed `equip` for that row. The
 * refusals stay in main.ts; the gestures are the panel's.
 *
 * THREE WAYS TO DO THE SAME THING, on purpose:
 *   * RIGHT-CLICK (or Enter, or A on a pad) runs the row's PRIMARY action —
 *     equip a weapon, drink a potion, send a beast in front.
 *   * DRAG onto a gear slot does the same by saying where it should go, and
 *     dragging OFF the panel drops the item in the world.
 *   * The footer strip carries what neither of those should ever do by
 *     accident: salvage and drop, on whatever is selected, as real buttons.
 * A left click only SELECTS. Nothing destructive is one click from anything.
 *
 * A FINGER HAS NONE OF THE FIRST TWO — no right-click, no hover, no HTML5 drag
 * — so on `(hover: none)` the primary action joins the footer as a button of its
 * own (see `footHtml`). Without it a phone player has a panel they can only
 * throw things away from, which is the one arrangement worse than no panel.
 *
 * THE TOOLTIP REPLACED A DETAIL PANE. The pane was a third of the panel's width
 * spent on the one row the cursor happened to be on, and on a dock that width
 * is the difference between five columns and three. A tooltip costs nothing
 * until the pointer is over something and follows it, and the actions it used
 * to carry moved to the footer — a tooltip cannot be clicked, which is exactly
 * why it is the right place for a description and the wrong place for a button.
 */

/** What a button, a right-click or a drop asks the host to do. */
export type InvAction =
  | 'equip' | 'unequip' | 'use' | 'salvage' | 'drop' | 'forge'
  | 'setLead' | 'setSupport';

type ActionKey = 'inv.equip' | 'inv.unequip' | 'inv.use' | 'inv.salvage'
  | 'inv.drop' | 'inv.forge' | 'inv.setLead' | 'inv.setSupport';

const ACTION_KEYS: Record<InvAction, ActionKey> = {
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
 * Actions that DESTROY something. They are never a row's primary, never what a
 * right-click or a drag does, and live only on the footer's own buttons.
 */
const DESTRUCTIVE: ReadonlySet<InvAction> = new Set<InvAction>(['salvage', 'drop']);

/** Which action a drop on each gear slot means. See the header. */
const SLOT_ACTION: Record<GearSlotId, InvAction> = {
  weapon: 'equip',
  primary: 'setLead',
  support: 'setSupport',
};

export type GearSlotId = 'weapon' | 'primary' | 'support';

/** One label/value pair in the tooltip. Both are already display strings. */
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
  /** Fallback tint, and the slot's glow. A portrait or an icon covers it. */
  color: number;
  /** A tile name in the weapon atlas, or absent. */
  icon?: string;
  /**
   * The species this row IS, for a beast. The panel does not read anything off
   * it except through the stage, which bakes its portrait — see `InventoryStage`
   * — so a beast row draws the actual model rather than a coloured lozenge.
   */
  species?: BeastSpecies;
  rarity?: ItemRarity;
  /** The tooltip's paragraph. */
  description?: string;
  stats?: readonly InvStat[];
  /** Draws the row as in-use, and is what the gear slots point at. */
  equipped?: boolean;
  /** One quiet line at the foot of the tooltip. */
  note?: string;
  actions?: readonly InvAction[];
}

export interface GearSlotView {
  slot: GearSlotId;
  entry: InvEntry | null;
}

export interface InventoryModel {
  gear: readonly GearSlotView[];
  entries: readonly InvEntry[];
}

export interface InventoryHooks {
  /** Rebuild the model — called on open and after every action. */
  model: () => InventoryModel;
  /** An action was asked for. The host mutates state; the panel re-reads. */
  onAction: (id: string, action: InvAction) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

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
 * Slots to a row.
 *
 * FIVE since the panel became a dock: the stylesheet lays the grid out from
 * this same number through `--cols`, and the keyboard's up/down steps by it to
 * mean "the row below". A media query that narrowed one without the other would
 * leave arrow-down skipping slots and nothing would fail — see the note on the
 * `.grid` rule in ui/styles.ts.
 */
export const INV_COLS = 5;

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const hexColor = (c: number): string => '#' + c.toString(16).padStart(6, '0');

const RARITY_KEYS: Record<ItemRarity, 'inv.rarity.common' | 'inv.rarity.rare' | 'inv.rarity.legendary'> = {
  common: 'inv.rarity.common',
  rare: 'inv.rarity.rare',
  legendary: 'inv.rarity.legendary',
};

const SLOT_LABELS: Record<GearSlotId, 'inv.slot.weapon' | 'inv.slot.primary' | 'inv.slot.support'> = {
  weapon: 'inv.slot.weapon',
  primary: 'inv.slot.primary',
  support: 'inv.slot.support',
};

export class InventoryPanel {
  private el: HTMLDivElement | null = null;
  private tip: HTMLDivElement | null = null;
  private tab: ItemKind | null = null;
  private selected: string | null = null;
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private pendingFocus: string | null = null;
  private padRaf = 0;
  private padDown = new Uint8Array(20);
  private padEdge = new Uint8Array(20);
  private padLatchY = false;
  private padLatchX = false;
  /** Id being dragged, or null. Survives a re-render; cleared on dragend. */
  private dragging: string | null = null;
  /** The model of the last render, so a hover does not have to rebuild one. */
  private rows = new Map<string, InvEntry>();
  private stage = new InventoryStage();

  constructor(private hooks: InventoryHooks) {
    injectStyles();
    // A portrait finishing is a ONE-ELEMENT change, so it patches the slots
    // that show that species rather than asking for a render: a rebuild here
    // would move the keyboard cursor out from under the player once per beast
    // as the queue drains.
    this.stage.onIcon = (id, url) => this.paintIcon(id, url);
  }

  get isOpen(): boolean { return this.el !== null; }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  open(): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'bs-inv';
    el.innerHTML =
      '<div class="bs-scrim"></div>' +
      '<aside class="pane bs-glass"></aside>' +
      '<div class="tip" aria-hidden="true"></div>';
    this.el = el;
    this.tip = el.querySelector('.tip');
    document.body.appendChild(el);
    el.addEventListener('click', this.onClick);
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('pointerover', this.onPointerOver);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerout', this.onPointerOut);
    el.addEventListener('dragstart', this.onDragStart);
    el.addEventListener('dragover', this.onDragOver);
    el.addEventListener('drop', this.onDropEvent);
    el.addEventListener('dragend', this.onDragEnd);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    this.render();
    this.pollPad();
    this.stage.start();
    requestAnimationFrame(() => el.classList.add('open'));
    this.hooks.onOpen?.();
  }

  close(): void {
    if (!this.el) return;
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    // The stage STOPS but is not disposed: its context, its rigs and its baked
    // portraits are what make the second open instant, and none of them is
    // session state. See the header of ui/inventory-stage.ts.
    this.stage.stop();
    this.padDown.fill(0);
    this.dragging = null;
    this.el.remove();
    this.el = null;
    this.tip = null;
    this.focusables = [];
    this.hooks.onClose?.();
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  /**
   * Re-read the model, if the panel is up.
   *
   * The panel is a modal, so almost nothing can change the bag behind it — but
   * `item.give` can (the dev console, and one day a piece of content that fires
   * on a timer), and a screen that quietly disagrees with the bag is worse than
   * a screen that costs a rebuild nobody asked for. Cheap: this runs on open
   * and after every action anyway.
   */
  refresh(): void {
    if (this.el) this.render();
  }

  /** The host saw a cancel. Returns whether this panel spent it. */
  onEscape(): boolean {
    if (!this.el) return false;
    this.close();
    return true;
  }

  dispose(): void {
    this.close();
    this.stage.dispose();
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  private render(): void {
    const el = this.el;
    if (!el) return;
    const model = this.hooks.model();
    const pane = el.querySelector('.pane') as HTMLElement;

    this.rows.clear();
    for (const e of model.entries) this.rows.set(e.id, e);
    for (const g of model.gear) if (g.entry) this.rows.set(g.entry.id, g.entry);

    const list = this.tab === null
      ? model.entries
      : model.entries.filter((e) => e.kind === this.tab);
    let sel = list.find((e) => e.id === this.selected) ?? null;
    if (!sel) sel = list[0] ?? null;
    this.selected = sel?.id ?? null;

    // NOTE what the next line does to the canvas: it detaches it. That is safe
    // and is the whole reason `InventoryStage` owns the element rather than
    // building one per render — a detached canvas keeps its WebGL context, its
    // programs and its textures for as long as something holds the reference,
    // and `stage.mount` below re-appends the same one. A context per render is
    // not a thing that could work.
    pane.innerHTML =
      `<div class="head"><h2>${escapeHtml(t('inv.title'))}</h2></div>` +
      '<div class="stage"></div>' +
      this.gearHtml(model.gear) +
      this.tabsHtml() +
      `<div class="grid" style="--cols:${INV_COLS}">${
        list.length
          ? list.map((e) => this.slotHtml(e)).join('')
          : `<p class="empty">${escapeHtml(t('inv.empty'))}</p>`
      }</div>` +
      this.footHtml(sel) +
      `<div class="foot">${t('inv.foot', { key: kbd('I'), esc: kbd('Esc') })}</div>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.type = 'button';
    closeBtn.dataset.act = 'close';
    closeBtn.innerHTML = CLOSE_ICON;
    (pane.querySelector('.head') as HTMLElement).appendChild(closeBtn);

    const cast = model.gear;
    this.stage.mount(pane.querySelector('.stage') as HTMLElement);
    this.stage.setCast(
      cast.find((g) => g.slot === 'primary')?.entry?.species ?? null,
      cast.find((g) => g.slot === 'support')?.entry?.species ?? null,
    );
    // After layout, because the canvas is a flex row and has no size until the
    // browser has laid the column out.
    requestAnimationFrame(() => this.stage.resize());

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  /**
   * The three gear slots, in the wireframe's order — the lead beast on the
   * left, the weapon in the middle, the support beast on the right — which is
   * the order the three figures stand in on the stage directly above them.
   */
  private gearHtml(gear: readonly GearSlotView[]): string {
    const order: GearSlotId[] = ['primary', 'weapon', 'support'];
    return '<div class="gear">' + order.map((slot) => {
      const e = gear.find((g) => g.slot === slot)?.entry ?? null;
      const cls = ['gs'];
      if (e) cls.push('full');
      if (e?.rarity) cls.push(`r-${e.rarity}`);
      return `<button class="${cls.join(' ')}" type="button" data-gear="${slot}"` +
        (e ? ` data-sel="${escapeHtml(e.id)}" draggable="true"` : '') +
        ` style="--el:${hexColor(e?.color ?? 0x64748b)}">` +
        `<span class="gs-ic">${e ? this.iconHtml(e) : ''}</span>` +
        // The slot's ROLE, and not the name of what is in it. A picture already
        // says which beast that is, and the name under it was a second label
        // saying the same thing in less detail — while being the one thing in
        // the strip that changes width, so the three slots jostled every time
        // the party changed. The item's name is the tooltip's job.
        `<span class="gs-l">${escapeHtml(t(SLOT_LABELS[slot]))}</span>` +
        '</button>';
    }).join('') + '</div>';
  }

  private tabsHtml(): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return `<button class="chip tab${on ? ' on' : ''}" type="button" role="tab"` +
        ` data-tab="${tb.id ?? 'all'}" aria-selected="${on}"${on ? '' : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.key as 'inv.tab.all'))}</button>`;
    }).join('')}</div>`;
  }

  /**
   * The picture in a slot, in preference order: a baked 3D PORTRAIT for a beast,
   * an atlas tile for a weapon or blueprint, and an element-coloured lozenge for
   * everything else.
   *
   * A beast whose portrait has not finished baking gets the lozenge and is
   * patched in place by `paintIcon` — see the note on `InventoryStage.iconFor`.
   * `data-beast` is what makes that patch findable.
   */
  private iconHtml(e: InvEntry): string {
    if (e.species) {
      const url = this.stage.iconFor(e.species);
      return `<i class="ic beast${url ? '' : ' blob'}" data-beast="${escapeHtml(e.species.id)}"` +
        ` style="--el:${hexColor(e.color)}${url ? `;background-image:url(${url})` : ''}"></i>`;
    }
    if (e.icon && isWeaponIcon(e.icon)) {
      return `<i class="ic" style="${weaponIconStyle(e.icon)}"></i>`;
    }
    return `<i class="ic blob" style="--el:${hexColor(e.color)}"></i>`;
  }

  /** A portrait arrived: fill in every slot showing that species, in place. */
  private paintIcon(speciesId: string, url: string): void {
    const el = this.el;
    if (!el) return;
    for (const i of el.querySelectorAll<HTMLElement>(`.ic.beast[data-beast="${speciesId}"]`)) {
      i.style.backgroundImage = `url(${url})`;
      i.classList.remove('blob');
    }
  }

  private slotHtml(e: InvEntry): string {
    const cls = ['slot'];
    if (e.rarity) cls.push(`r-${e.rarity}`);
    if (e.equipped) cls.push('on');
    if (e.id === this.selected) cls.push('sel');
    return `<button class="${cls.join(' ')}" type="button" draggable="true"` +
      ` data-sel="${escapeHtml(e.id)}" style="--el:${hexColor(e.color)}">` +
      this.iconHtml(e) +
      (e.count > 1 ? `<span class="n">${e.count}</span>` : '') +
      '</button>';
  }

  /**
   * The footer strip: what is selected, and the two things that destroy it.
   *
   * ONLY the destructive actions. Everything constructive is a right-click, an
   * Enter or a drag away, and putting Equip here too would have made the strip
   * a detail pane again by a different name.
   */
  private footHtml(sel: InvEntry | null): string {
    if (!sel) return '<div class="sel"></div>';
    const acts = (sel.actions ?? []).filter((a) => DESTRUCTIVE.has(a));
    const primary = this.primaryOf(sel);
    // ON A DEVICE WITH NO POINTER THE PRIMARY BECOMES A BUTTON, and that is not
    // a nicety: a finger cannot right-click, cannot hover and cannot start an
    // HTML5 drag, so on a phone every one of the three ways to equip something
    // is gone and the panel would be a wall you can only throw things away
    // from. `(hover: none)` is the exact question — not "is this small", which
    // a desktop window is too — and it is asked at RENDER time rather than
    // cached, so a tablet with a mouse plugged in answers correctly on the next
    // open. It is a GHOST button beside two danger ones, so the destructive
    // pair still reads as the loud thing on the strip.
    const noPointer = window.matchMedia?.('(hover: none)').matches ?? false;
    return '<div class="sel">' +
      `<span class="nm">${escapeHtml(sel.name)}</span>` +
      (primary && !noPointer
        ? `<span class="hint">${escapeHtml(t('inv.rmb', { action: t(ACTION_KEYS[primary]) }))}</span>`
        : '') +
      (primary && noPointer
        ? `<button class="bs-buy ghost" type="button" data-do="${primary}">` +
          `${escapeHtml(t(ACTION_KEYS[primary]))}</button>`
        : '') +
      acts.map((a) =>
        `<button class="bs-buy danger" type="button" data-do="${a}">` +
        `${escapeHtml(t(ACTION_KEYS[a]))}</button>`).join('') +
      '</div>';
  }

  // -------------------------------------------------------------------------
  // The tooltip
  // -------------------------------------------------------------------------

  private showTip(e: InvEntry, x: number, y: number): void {
    const tip = this.tip;
    if (!tip) return;
    tip.innerHTML =
      `<h3 style="--el:${hexColor(e.color)}">${escapeHtml(e.name)}</h3>` +
      (e.rarity ? `<span class="rar r-${e.rarity}">${escapeHtml(t(RARITY_KEYS[e.rarity]))}</span>` : '') +
      (e.description ? `<p>${escapeHtml(e.description)}</p>` : '') +
      (e.stats?.length
        ? `<div class="bs-chips">${e.stats.map((s) =>
            `<span class="bs-chip">${escapeHtml(s.label)} <b>${escapeHtml(s.value)}</b></span>`).join('')}</div>`
        : '') +
      (e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : '');
    tip.classList.add('on');
    this.moveTip(x, y);
  }

  /**
   * Keep the tooltip beside the pointer and INSIDE the window.
   *
   * It is measured rather than flipped at a breakpoint because the panel is
   * docked to the right edge: every slot in it is within a tooltip's width of
   * that edge, so "left of the pointer" is the normal case and clamping is what
   * stops the bottom rows running off the bottom.
   */
  private moveTip(x: number, y: number): void {
    const tip = this.tip;
    if (!tip) return;
    const r = tip.getBoundingClientRect();
    const pad = 12;
    const left = Math.max(pad, Math.min(x - r.width - 18, window.innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(y - 12, window.innerHeight - r.height - pad));
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  private hideTip(): void {
    this.tip?.classList.remove('on');
  }

  private entryAt(target: EventTarget | null): InvEntry | null {
    const btn = (target as HTMLElement | null)?.closest?.('[data-sel]') as HTMLElement | null;
    const id = btn?.dataset.sel;
    return id ? this.rows.get(id) ?? null : null;
  }

  private onPointerOver = (ev: PointerEvent): void => {
    const e = this.entryAt(ev.target);
    if (e) this.showTip(e, ev.clientX, ev.clientY);
    else this.hideTip();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.tip?.classList.contains('on')) this.moveTip(ev.clientX, ev.clientY);
  };

  private onPointerOut = (ev: PointerEvent): void => {
    if (!this.entryAt(ev.relatedTarget)) this.hideTip();
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** The row's PRIMARY action: the first one that does not destroy it. */
  private primaryOf(e: InvEntry): InvAction | null {
    return (e.actions ?? []).find((a) => !DESTRUCTIVE.has(a)) ?? null;
  }

  private run(id: string, action: InvAction, focus?: string): void {
    this.hideTip();
    this.hooks.onAction(id, action);
    if (!this.el) return;   // the host may have closed us from inside the action
    this.pendingFocus = focus ?? `[data-sel="${id}"]`;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || !this.el) return;
    // The scrim IS a way out, unlike the pause menu's: the world behind it is
    // still the thing you came for. Same argument the shop makes.
    if (target.classList.contains('bs-scrim')) { this.close(); return; }
    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    if (btn.dataset.act === 'close') { this.close(); return; }

    const tab = btn.dataset.tab;
    if (tab !== undefined) { this.showTab(tab === 'all' ? null : tab as ItemKind); return; }

    const act = btn.dataset.do as InvAction | undefined;
    if (act && this.selected) { this.run(this.selected, act, `[data-do="${act}"]`); return; }

    // A LEFT CLICK ONLY SELECTS. Nothing destructive is one click away from
    // anything, and the footer's buttons are what the selection is for.
    const sel = btn.dataset.sel;
    if (sel !== undefined) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
    }
  };

  private onContextMenu = (ev: MouseEvent): void => {
    const e = this.entryAt(ev.target);
    if (!e) return;
    // Always, even when there is nothing to do: a browser context menu over an
    // inventory slot is never what the player meant by that press.
    ev.preventDefault();
    const a = this.primaryOf(e);
    if (a) this.run(e.id, a);
  };

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  private onDragStart = (ev: DragEvent): void => {
    const e = this.entryAt(ev.target);
    if (!e) { ev.preventDefault(); return; }
    this.dragging = e.id;
    this.hideTip();
    this.el?.classList.add('dragging');
    // `setData` is required or Firefox refuses to start a drag at all. The
    // payload is our own id and nothing reads it back — `this.dragging`
    // survives the re-render a drop causes, where a DataTransfer does not.
    ev.dataTransfer?.setData('text/plain', e.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  };

  /**
   * Which action dropping the dragged row HERE would mean, or null if this is
   * not a target for it.
   *
   * The gear slots are the mapping in `SLOT_ACTION` — and each is gated on the
   * host having listed that action for the row, so the panel never sends an
   * `equip` for a potion and the "does this go here" answer on screen is the
   * same one the host would give. The GRID is where a gear slot's contents go
   * to be taken off, and the SCRIM is the world.
   */
  private dropAction(target: EventTarget | null): InvAction | null {
    const e = this.dragging ? this.rows.get(this.dragging) : null;
    if (!e) return null;
    const el = target as HTMLElement | null;
    const gear = el?.closest?.('[data-gear]') as HTMLElement | null;
    if (gear) {
      const want = SLOT_ACTION[gear.dataset.gear as GearSlotId];
      return (e.actions ?? []).includes(want) ? want : null;
    }
    if (el?.closest?.('.grid')) {
      return (e.actions ?? []).includes('unequip') ? 'unequip' : null;
    }
    if (el?.classList.contains('bs-scrim')) {
      return (e.actions ?? []).includes('drop') ? 'drop' : null;
    }
    return null;
  }

  private onDragOver = (ev: DragEvent): void => {
    const a = this.dropAction(ev.target);
    if (!a) return;
    // preventDefault is what makes an element a drop target at all.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const host = (ev.target as HTMLElement).closest('[data-gear], .grid, .bs-scrim');
    for (const n of this.el?.querySelectorAll('.drop-ok') ?? []) n.classList.remove('drop-ok');
    host?.classList.add('drop-ok');
  };

  private onDropEvent = (ev: DragEvent): void => {
    const a = this.dropAction(ev.target);
    const id = this.dragging;
    this.onDragEnd();
    if (!a || !id) return;
    ev.preventDefault();
    this.run(id, a);
  };

  private onDragEnd = (): void => {
    this.dragging = null;
    this.el?.classList.remove('dragging');
    for (const n of this.el?.querySelectorAll('.drop-ok') ?? []) n.classList.remove('drop-ok');
  };

  // -------------------------------------------------------------------------
  // Keyboard and pad
  // -------------------------------------------------------------------------

  private showTab(tab: ItemKind | null): void {
    this.tab = tab;
    this.pendingFocus = `[data-tab="${tab ?? 'all'}"]`;
    this.render();
  }

  private onResize = (): void => { this.stage.resize(); };

  /**
   * Arrows walk the panel and Enter runs the focused row's primary action —
   * the same thing a right-click does, so a keyboard player has the whole panel
   * without a pointer.
   *
   * ESCAPE IS NOT HERE, for the reason ui/pause.ts gives at length: it reaches
   * this panel from three devices and only one of them is a DOM key event, so
   * the host owns that edge for all three. `KeyI` is the same case.
   */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.el) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    switch (ev.key) {
      case 'ArrowRight': if (!this.stepStrip(1)) this.moveFocus(1); ev.preventDefault(); break;
      case 'ArrowLeft': if (!this.stepStrip(-1)) this.moveFocus(-1); ev.preventDefault(); break;
      case 'ArrowDown': ev.preventDefault(); this.moveFocus(this.rowStep(1)); break;
      case 'ArrowUp': ev.preventDefault(); this.moveFocus(this.rowStep(-1)); break;
      case 'Enter': {
        const here = document.activeElement as HTMLElement | null;
        // Only a SLOT. Enter on a tab or a footer button is the platform's own
        // click, and stealing it would break both.
        if (!here?.dataset.sel) return;
        const e = this.rows.get(here.dataset.sel);
        const a = e ? this.primaryOf(e) : null;
        if (e && a) { ev.preventDefault(); this.run(e.id, a); }
        break;
      }
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

  private rowStep(dir: -1 | 1): number {
    const here = document.activeElement as HTMLElement | null;
    return here?.classList.contains('slot') ? INV_COLS * dir : dir;
  }

  moveFocus(d: number): void {
    if (!this.focusables.length) return;
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    const n = this.focusables.length;
    // CLAMPED for a multi-stop jump, wrapped for a single step: a down-arrow on
    // the last half-row of slots should land on the last slot, not spring back
    // to the tabs, while a pad circling with one step should circle.
    let next = from + d;
    if (Math.abs(d) > 1) next = Math.min(n - 1, Math.max(0, next));
    else next = (next + n) % n;
    this.focusIdx = next;
    const el = this.focusables[this.focusIdx];
    el.focus();
    // Selecting as the cursor passes is what makes the footer follow a pad
    // without a press — but only for a SLOT, or arrowing onto Salvage would
    // change what Salvage is pointed at.
    const sel = el.dataset.sel;
    if (sel !== undefined && el.classList.contains('slot') && sel !== this.selected) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
    }
  }

  /** Enter/A on the focused control, for a host driving this from `Input`. */
  activate(): void {
    const here = document.activeElement as HTMLButtonElement | null;
    const id = here?.dataset.sel;
    const e = id ? this.rows.get(id) : null;
    const a = e && here?.classList.contains('slot') ? this.primaryOf(e) : null;
    if (e && a) this.run(e.id, a);
    else here?.click();
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
