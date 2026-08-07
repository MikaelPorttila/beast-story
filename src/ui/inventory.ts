import { t } from '../i18n';
import type { BeastSpecies, ItemKind, ItemRarity } from '../core/types';
import { injectStyles } from './styles';
import { CLOSE_ICON, RMB_ICON, tameOrbIcon } from './icons';
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
 *   * The footer strip carries every action the host offered as a real button,
 *     which is what a finger has instead of the first two.
 * A left PRESS picks the row up (see `onPointerDown`) and a left click that
 * moved nowhere only SELECTS. Nothing destructive is one click from anything.
 *
 * A GEAR SLOT IS A REAL SLOT, and what is in one is not on the wall as well
 * (issue #116). The host decides that — see `inventoryModel` — and what the
 * panel owes it is a way to SELECT a gear slot, because the footer is where an
 * equipped row's Unequip button lives and the wall no longer has a copy of that
 * row to click.
 *
 * THE DRAG IS POINTER EVENTS AND NOT HTML5 DRAG-AND-DROP (issue #116). The
 * native gesture could only ever say "this row was dropped on that element",
 * which is enough to equip and not enough to REARRANGE — a wall the player
 * arranges needs a press that picks a box up on the spot, a ghost under the
 * cursor saying which box is in the air, and a cell index under it saying where
 * it will land. Pointer events also come off a pen and a touchscreen, where
 * `dragstart` never fires at all.
 *
 * THE TOOLTIP REPLACED A DETAIL PANE. The pane was a third of the panel's width
 * spent on the one row the cursor happened to be on, and on a dock that width
 * is the difference between five columns and three. A tooltip costs nothing
 * until the pointer is over something and follows it, and the actions it used
 * to carry moved to the footer — a tooltip cannot be clicked, which is exactly
 * why it is the right place for a description and the wrong place for a button.
 */

/**
 * HOW THE PANEL WAS DISMISSED, and it is on the contract for one reason: taking
 * the pointer lock back is safe after some of these and not after others.
 *
 * `escape` is the dangerous one. In a browser with no keyboard lock — Brave
 * nulls `navigator.keyboard`; see ui/fullscreen.ts — that key is the BROWSER'S,
 * and it is at that moment also leaving fullscreen, which drops the pointer
 * lock about 8 ms later. A host that re-takes the lock on the way out hands the
 * browser something to knock straight back out, and `Input.onLockLost` reads
 * that as the player pressing Escape again: the inventory closed and the
 * in-game menu opened behind it, on one press. `hotkey` (`I`) and `click` are
 * safe, because the browser is not spending either.
 *
 * This is the same contract `PauseMenu.onClose` carries and for the same
 * reason; it is three values rather than that one's two because this panel has
 * a key of its own that is not Escape.
 */
export type InvCloseBy = 'escape' | 'hotkey' | 'click';

/** What a button, a right-click or a drop asks the host to do. */
export type InvAction =
  | 'equip' | 'unequip' | 'use' | 'salvage' | 'drop' | 'forge'
  | 'setLead' | 'setSupport' | 'ready' | 'unready';

type ActionKey = 'inv.equip' | 'inv.unequip' | 'inv.use' | 'inv.salvage'
  | 'inv.drop' | 'inv.forge' | 'inv.setLead' | 'inv.setSupport'
  | 'inv.ready' | 'inv.unready';

const ACTION_KEYS: Record<InvAction, ActionKey> = {
  equip: 'inv.equip',
  unequip: 'inv.unequip',
  use: 'inv.use',
  salvage: 'inv.salvage',
  drop: 'inv.drop',
  forge: 'inv.forge',
  setLead: 'inv.setLead',
  setSupport: 'inv.setSupport',
  // `ready`/`unready` and not `equip`/`unequip`, though the mechanism is the
  // same slot: what the player does with a sword is hold it, and what they do
  // with an orb is have it to hand. The pair also keeps the two slots' buttons
  // distinguishable in the footer when both are offered on the same screen.
  ready: 'inv.ready',
  unready: 'inv.unready',
};

/**
 * Actions that DESTROY something. They are never a row's primary, never what a
 * right-click or a drag does, and live only on the footer's own buttons.
 */
const DESTRUCTIVE: ReadonlySet<InvAction> = new Set<InvAction>(['salvage', 'drop']);

/**
 * WHAT EACH GEAR SLOT DOES WITH A ROW, both ways: `put` is what dropping one on
 * the slot means, `take` is what dragging one out of it means.
 *
 * ONE TABLE AND NOT TWO HALVES, because the two halves drifted. `put` was a map
 * from the start and `take` was the word "unequip" written into the drag code —
 * which is right for the three slots that use it and wrong for the ORB, whose
 * action is `unready` (see ACTION_KEYS on why the orb has its own pair of
 * words). The orb could be dropped INTO its slot and not dragged out of it, and
 * nothing said so: the panel simply refused a gesture it had no name for.
 *
 * Every slot goes through both fields, so a fifth slot is a row here and no new
 * branch anywhere. Both are still gated on the host having listed that action
 * for the row — the panel names the gesture, the host owns the rule.
 */
const SLOT_ACTIONS: Record<GearSlotId, { put: InvAction; take: InvAction }> = {
  weapon: { put: 'equip', take: 'unequip' },
  primary: { put: 'setLead', take: 'unequip' },
  support: { put: 'setSupport', take: 'unequip' },
  orb: { put: 'ready', take: 'unready' },
};

export type GearSlotId = 'weapon' | 'primary' | 'support' | 'orb';

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
   * Which taming orb this is, 1-4 — `ItemDef.orbTier`, for an `orb` row.
   *
   * The panel reads it for one thing: how many notches the glyph carries (see
   * `iconHtml`). It is not shown as a number anywhere, because the tier is a
   * RANK and the four names already say it.
   */
  orbTier?: number;
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
  /**
   * WHICH CELL OF THE WALL this row sits in — the host's `SlotLayout` answer,
   * and the whole of issue #116's "no sorting". The panel places the row there
   * and draws an empty cell wherever no row claims one; it never sorts, never
   * packs and never decides that a hole should close up.
   *
   * Absent means "the host does not place this kind of row", and those fall
   * back to the order they arrived in — nothing ships that way, but a panel
   * that dropped rows it was handed would be a worse failure than one that
   * stacked them at the front.
   */
  slot?: number;
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
  /**
   * The player dragged a row onto cell `slot` of the wall. Not an `InvAction`
   * because it carries a number and because it is the one gesture that changes
   * NOTHING about the game — a moved box is worth no toast, no rule and no
   * refusal, and the host's only job is to write it down. See `InvEntry.slot`.
   */
  onMove: (id: string, slot: number) => void;
  onOpen?: () => void;
  /** See `InvCloseBy` — the host needs to know HOW, not just that. */
  onClose?: (by: InvCloseBy) => void;
}

const TABS: readonly { id: ItemKind | null; key: string }[] = [
  { id: null, key: 'inv.tab.all' },
  { id: 'beast', key: 'inv.tab.beast' },
  { id: 'weapon', key: 'inv.tab.weapon' },
  { id: 'orb', key: 'inv.tab.orb' },
  { id: 'blueprint', key: 'inv.tab.blueprint' },
  { id: 'potion', key: 'inv.tab.potion' },
  { id: 'stackable', key: 'inv.tab.stackable' },
  { id: 'quest', key: 'inv.tab.quest' },
];

/**
 * THE BAG IS ELEVEN ACROSS AND THREE DEEP — thirty-three slots, drawn whether
 * or not there is anything in them.
 *
 * A FIXED wall rather than a list that grows, which is the difference between
 * an inventory and a receipt: a player learns where things are by their
 * POSITION, and a grid that reflows every time a stack empties has no positions
 * to learn. Empty cells are real cells, so the shape of the panel never moves —
 * and since issue #116 a cell is also where the row IS, not where the model
 * happened to list it. See `InvEntry.slot`.
 *
 * `INV_COLS` is handed to the stylesheet through `--cols` and is also what the
 * keyboard's up/down steps by to mean "the row below"; a media query that
 * narrowed one without the other would leave arrow-down skipping slots and
 * nothing would fail. See the note on the `.grid` rule in ui/styles.ts.
 *
 * Past thirty-three the wall keeps going and scrolls. A cap that REFUSED items
 * is a different feature and a crueller one; this is not the ticket that
 * decides the player may not pick something up.
 */
export const INV_COLS = 11;
export const INV_ROWS = 3;

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

/**
 * How far a left press must travel before it is a DRAG rather than a click.
 * Five pixels: a deliberate click with a shaky hand moves one or two, and a
 * player who means to pick a box up has moved five before they have thought
 * about it.
 */
const DRAG_SLOP = 5;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const hexColor = (c: number): string => '#' + c.toString(16).padStart(6, '0');

const RARITY_KEYS: Record<ItemRarity, 'inv.rarity.common' | 'inv.rarity.rare' | 'inv.rarity.legendary'> = {
  common: 'inv.rarity.common',
  rare: 'inv.rarity.rare',
  legendary: 'inv.rarity.legendary',
};

const SLOT_LABELS: Record<
  GearSlotId,
  'inv.slot.weapon' | 'inv.slot.primary' | 'inv.slot.support' | 'inv.slot.orb'
> = {
  weapon: 'inv.slot.weapon',
  primary: 'inv.slot.primary',
  support: 'inv.slot.support',
  orb: 'inv.slot.orb',
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
  /** A left press that has not yet travelled far enough to be a drag. */
  private press: { id: string; x: number; y: number; slot: GearSlotId | null } | null = null;
  /** Id in the air, or null. See `beginDrag`. */
  private dragging: string | null = null;
  /**
   * WHICH GEAR SLOT the id in the air came out of, or null for the wall. The
   * slot and not a boolean: what dragging a row OUT means is per-slot, and
   * `SLOT_ACTIONS[…].take` is the only place that decides it.
   */
  private fromSlot: GearSlotId | null = null;
  /** The box under the cursor while one is in the air; never a drop target. */
  private ghost: HTMLDivElement | null = null;
  /**
   * A drag happened, so the `click` the browser fires on the way out is not a
   * selection. A press that never moved leaves this false and selects, which is
   * the whole of "a left click only selects, a left press picks up".
   */
  private dragged = false;
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
    el.addEventListener('pointerdown', this.onPointerDown);
    // ON THE WINDOW, unlike every other listener here: a drag that ends over
    // the browser's own chrome still has to let go of the box. The panel covers
    // the viewport, so an ordinary release inside it reaches this by bubbling.
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    this.render();
    this.pollPad();
    this.stage.start();
    requestAnimationFrame(() => el.classList.add('open'));
    this.hooks.onOpen?.();
  }

  close(by: InvCloseBy = 'click'): void {
    if (!this.el) return;
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    // The stage STOPS but is not disposed: its context, its rigs and its baked
    // portraits are what make the second open instant, and none of them is
    // session state. See the header of ui/inventory-stage.ts.
    this.stage.stop();
    this.padDown.fill(0);
    this.endDrag();
    this.el.remove();
    this.el = null;
    this.tip = null;
    this.focusables = [];
    this.hooks.onClose?.(by);
  }

  /** The host's `I` (and the pad's View/Create, which taps the same code). */
  toggle(): void {
    if (this.el) this.close('hotkey');
    else this.open();
  }

  /** What the 3D stage is actually drawing, for the probe. See `castIds`. */
  stageCast(): (string | null)[] {
    return this.stage.castIds();
  }

  /**
   * What the hero on the STAGE is holding, by `ItemDef.model` name.
   *
   * A pass-through to the stage, which owns the guard — the panel does not
   * type-check a weapon name any more than it checks an item id. Called by the
   * host's `applyLoadout` whether the panel is open or shut, because the stage
   * outlives the panel and must be right the next time it is drawn.
   */
  setHeroWeapon(model: string | null | undefined): void {
    this.stage.setHeroWeapon(model);
    if (this.el) this.render();
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

  /**
   * The host saw a cancel. Returns whether this panel SPENT it — which the host
   * uses to decide there is nothing left for that press to do, so one Escape
   * closes one thing.
   */
  onEscape(): boolean {
    if (!this.el) return false;
    this.close('escape');
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

    const cells = this.wall(model.entries);
    const shown = (e: InvEntry | null): boolean =>
      e !== null && (this.tab === null || e.kind === this.tab);
    const list = cells.filter((e) => shown(e)) as InvEntry[];
    // THE SELECTION MAY BE IN A GEAR SLOT and not on the wall at all, since what
    // is equipped stopped being drawn twice: the footer is where an equipped
    // row's Unequip lives, and a phone with no right-click has no other way to
    // reach it. Falls back to the first row on the wall, as it always did.
    let sel = this.selected === null ? null
      : list.find((e) => e.id === this.selected)
        ?? model.gear.find((g) => g.entry?.id === this.selected)?.entry
        ?? null;
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
        // Three kinds of cell, and the third is the one the tabs cost: a row
        // the filter is hiding still OWNS its cell, so that cell is drawn empty
        // and takes no drop — a swap with a box you cannot see is a move the
        // player did not make.
        cells.map((e, i) => (shown(e) ? this.slotHtml(e as InvEntry, i)
          : `<div class="slot empty${e ? ' held' : ''}"${e ? '' : ` data-slot="${i}"`}></div>`))
          .join('')
      }</div>` +
      this.footHtml(sel);

    // The X, with the KEYS that do the same thing printed beside it rather than
    // spelled out in a sentence along the bottom of the panel. `.cap` is hidden
    // where there is no keyboard — see the media query in ui/styles.ts.
    const head = pane.querySelector('.head') as HTMLElement;
    head.insertAdjacentHTML('beforeend', `<span class="cap">${kbd('I')}${kbd('Esc')}</span>`);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.type = 'button';
    closeBtn.dataset.act = 'close';
    closeBtn.innerHTML = CLOSE_ICON;
    head.appendChild(closeBtn);

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
   * The gear slots, in the wireframe's order — the lead beast on the left, the
   * weapon in the middle, the support beast on the right — which is the order
   * the three figures stand in on the stage directly above them.
   *
   * THE ORB SLOT IS FOURTH, on the end rather than beside the weapon, and the
   * reason is that same stage: the first three slots sit under the bodies they
   * hold, and an orb has nobody standing over it. Putting it between the weapon
   * and the support beast would have broken the one thing the strip's order
   * means.
   */
  private gearHtml(gear: readonly GearSlotView[]): string {
    const order: GearSlotId[] = ['primary', 'weapon', 'support', 'orb'];
    return '<div class="gear">' + order.map((slot) => {
      const e = gear.find((g) => g.slot === slot)?.entry ?? null;
      const cls = ['gs'];
      if (e) cls.push('full');
      if (e?.rarity) cls.push(`r-${e.rarity}`);
      if (e && e.id === this.selected) cls.push('sel');
      return `<button class="${cls.join(' ')}" type="button" data-gear="${slot}"` +
        (e ? ` data-sel="${escapeHtml(e.id)}"` : '') +
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
   * an atlas tile for a weapon or blueprint, an inline glyph for an orb, and an
   * element-coloured lozenge for everything else.
   *
   * A beast whose portrait has not finished baking gets the lozenge and is
   * patched in place by `paintIcon` — see the note on `InventoryStage.iconFor`.
   * `data-beast` is what makes that patch findable.
   *
   * THE ORB IS AN SVG AND NOT AN ATLAS TILE, unlike the weapons beside it. Four
   * orbs are one drawing with a notch count (see `orbIcon` in ui/icons.ts), so
   * the art IS the parameter — which is the exact case the atlas exception was
   * NOT taken for. It also inherits the item's own colour through
   * `currentColor`, where a packed tile would have baked four fixed hues.
   */
  private iconHtml(e: InvEntry): string {
    if (e.species) {
      const url = this.stage.iconFor(e.species);
      return `<i class="ic beast${url ? '' : ' blob'}" data-beast="${escapeHtml(e.species.id)}"` +
        ` style="--el:${hexColor(e.color)}${url ? `;background-image:url(${url})` : ''}"></i>`;
    }
    if (e.kind === 'orb') {
      return `<i class="ic glyph" style="--el:${hexColor(e.color)}">${tameOrbIcon(e.orbTier)}</i>`;
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

  /**
   * The wall, cell by cell: every row put where its `slot` says, and a null for
   * every cell nothing claims.
   *
   * THE LENGTH IS THE FIXED 33 OR THE FURTHEST ROW, whichever is more, so a bag
   * past the third row grows a fourth rather than hiding what is in it — and a
   * player who parked something on cell 40 gets the empty cells between kept,
   * because a hole they made is a hole they meant.
   *
   * A row with no `slot` (or one already taken, which the host's layout does not
   * produce) falls into the first free cell rather than being dropped.
   */
  private wall(entries: readonly InvEntry[]): (InvEntry | null)[] {
    let span = INV_COLS * INV_ROWS;
    for (const e of entries) if (e.slot !== undefined && e.slot + 1 > span) span = e.slot + 1;
    const cells: (InvEntry | null)[] = new Array(Math.ceil(span / INV_COLS) * INV_COLS).fill(null);
    const spare: InvEntry[] = [];
    for (const e of entries) {
      if (e.slot !== undefined && e.slot >= 0 && cells[e.slot] === null) cells[e.slot] = e;
      else spare.push(e);
    }
    for (const e of spare) {
      const i = cells.indexOf(null);
      if (i < 0) cells.push(e); else cells[i] = e;
    }
    return cells;
  }

  private slotHtml(e: InvEntry, cell: number): string {
    const cls = ['slot'];
    if (e.rarity) cls.push(`r-${e.rarity}`);
    if (e.equipped) cls.push('on');
    if (e.id === this.selected) cls.push('sel');
    return `<button class="${cls.join(' ')}" type="button" data-slot="${cell}"` +
      ` data-sel="${escapeHtml(e.id)}" style="--el:${hexColor(e.color)}">` +
      this.iconHtml(e) +
      (e.count > 1 ? `<span class="n">${e.count}</span>` : '') +
      '</button>';
  }

  /**
   * The footer strip: what is selected, and the buttons for it.
   *
   * EVERY ACTION IS A BUTTON, and the one that is also bound to a control wears
   * that control as a small ICON rather than as a sentence. "Right-click to
   * equip" was a line of prose that had to be read; a mouse glyph on the button
   * is the same fact in the place the player is already looking, and it costs
   * no width. Salvage and Drop have no binding, so they carry nothing — that is
   * the rule working rather than an omission.
   *
   * The buttons are real on EVERY device rather than only where there is no
   * pointer: a finger has none of the gestures — no right-click, no hover — and
   * a panel a phone player can only throw things away from is the one
   * arrangement worse than no panel. What the media query hides there is the
   * GLYPH, not the button.
   *
   * EVERY ACTION THE HOST OFFERED IS HERE, not only the primary one (issue
   * #116). A benched beast can be sent in front OR to support and a beast in a
   * slot can be taken out of it, and only one of those was ever a right-click:
   * a row whose second action existed but had no button was a rule the panel
   * knew and never showed. The primary keeps the mouse glyph, because it is the
   * one that is also bound to something.
   */
  private footHtml(sel: InvEntry | null): string {
    if (!sel) return '<div class="sel"></div>';
    const all = sel.actions ?? [];
    const primary = this.primaryOf(sel);
    const button = (a: InvAction, cls: string, bound: boolean): string =>
      `<button class="bs-buy ${cls}" type="button" data-do="${a}">` +
      (bound ? `<i class="cap">${RMB_ICON}</i>` : '') +
      `<span>${escapeHtml(t(ACTION_KEYS[a]))}</span></button>`;
    return '<div class="sel">' +
      `<span class="nm">${escapeHtml(sel.name)}</span>` +
      all.map((a) => (a === primary ? button(a, 'ghost', true)
        : DESTRUCTIVE.has(a) ? button(a, 'danger', false)
        : button(a, 'ghost', false))).join('') +
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
    if (this.dragging) return;   // the box in the air is what is being read
    const e = this.entryAt(ev.target);
    if (e) this.showTip(e, ev.clientX, ev.clientY);
    else this.hideTip();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.dragging) { this.dragTo(ev.clientX, ev.clientY); return; }
    if (this.press && Math.hypot(ev.clientX - this.press.x, ev.clientY - this.press.y) > DRAG_SLOP) {
      this.beginDrag(ev);
      return;
    }
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
    // The browser fires a click at the end of a drag as well, on whichever
    // ancestor both ends share. It is not a selection and it is certainly not
    // the scrim's "close" — see `dragged`.
    if (this.dragged) { this.dragged = false; return; }
    // The scrim IS a way out, unlike the pause menu's: the world behind it is
    // still the thing you came for. Same argument the shop makes.
    if (target.classList.contains('bs-scrim')) { this.close('click'); return; }
    const btn = target.closest('button') as HTMLButtonElement | null;
    if (!btn) return;

    if (btn.dataset.act === 'close') { this.close('click'); return; }

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

  /**
   * A LEFT PRESS PICKS THE ROW UP — issue #116, and the reason this panel no
   * longer uses HTML5 drag-and-drop at all.
   *
   * Nothing happens yet. The press is only remembered, and it becomes a drag in
   * `onPointerMove` once the pointer has travelled `DRAG_SLOP`; below that it is
   * a click and the click handler selects. Both readings have to stay available
   * off one button, and a threshold is the only thing that tells them apart —
   * a press that acted immediately would make every selection a move of one or
   * two pixels.
   *
   * A FINGER IS NOT A DRAG HERE. The wall scrolls, touch has no second gesture
   * to spend on that, and every action a drag can reach is a button in the
   * footer — which is what `footHtml` is for. A pen is a mouse.
   */
  private onPointerDown = (ev: PointerEvent): void => {
    // Cleared HERE and not only where it is read: a drag that ended off the
    // window fires no click at all, and a flag left standing would eat the next
    // real one.
    this.dragged = false;
    if (ev.button !== 0 || ev.pointerType === 'touch') return;
    const btn = (ev.target as HTMLElement | null)?.closest?.('[data-sel]') as HTMLElement | null;
    const id = btn?.dataset.sel;
    if (!btn || !id || !this.rows.has(id)) return;
    this.press = {
      id, x: ev.clientX, y: ev.clientY,
      slot: (btn.dataset.gear as GearSlotId | undefined) ?? null,
    };
  };

  /** Past the slop the press is a drag. 5px, which is a click with a shaky hand. */
  private beginDrag(ev: PointerEvent): void {
    const press = this.press;
    const e = press ? this.rows.get(press.id) : null;
    if (!press || !e || !this.el) return;
    this.dragging = press.id;
    this.fromSlot = press.slot;
    this.dragged = true;
    this.hideTip();
    this.el.classList.add('dragging');
    // The ghost is the box IN THE AIR, and it is what makes a rearrange
    // readable: the cell it came from stays where it was, dimmed, and the thing
    // the player is holding is under the cursor. `pointer-events:none` in the
    // stylesheet is load-bearing — `elementFromPoint` below reads through it.
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.setProperty('--el', hexColor(e.color));
    ghost.innerHTML = this.iconHtml(e);
    this.el.appendChild(ghost);
    this.ghost = ghost;
    this.dragTo(ev.clientX, ev.clientY);
  }

  /** Follow the cursor and light the cell under it. */
  private dragTo(x: number, y: number): void {
    if (this.ghost) this.ghost.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    for (const n of this.el?.querySelectorAll('.drop-ok') ?? []) n.classList.remove('drop-ok');
    this.dropTarget(document.elementFromPoint(x, y))?.host.classList.add('drop-ok');
  }

  /**
   * What letting go HERE would mean: an action the host has to run, or a cell
   * the panel simply writes the row into.
   *
   * BOTH DIRECTIONS COME OUT OF `SLOT_ACTIONS`, which is what keeps the four
   * slots one mechanism: dropping on a slot is that slot's `put`, and dropping
   * a row dragged OUT of a slot is that slot's `take`. Each is gated on the
   * host having listed the action for the row, so the panel never sends an
   * `equip` for a potion and the "does this go here" answer on screen is the
   * same one the host would give. The WALL is therefore two answers depending
   * on where the row was picked up — out of a slot it is where gear comes off,
   * off the wall itself it is a MOVE. The SCRIM is the world.
   */
  private dropTarget(node: Element | null): {
    host: Element; action?: InvAction; slot?: number;
  } | null {
    const e = this.dragging ? this.rows.get(this.dragging) : null;
    const el = node as HTMLElement | null;
    if (!e || !el) return null;
    // `offers` and not `has`: tools/test-keybinds.mjs finds every key code the
    // game reads by scanning src/ for a call to `has` with a quoted literal in
    // it, and a helper by that name taking an action name reads to it as an
    // undocumented binding.
    const offers = (a: InvAction): boolean => (e.actions ?? []).includes(a);

    const gear = el.closest('[data-gear]') as HTMLElement | null;
    if (gear) {
      const want = SLOT_ACTIONS[gear.dataset.gear as GearSlotId].put;
      return offers(want) ? { host: gear, action: want } : null;
    }
    const cell = el.closest('[data-slot]') as HTMLElement | null;
    if (cell) {
      const slot = Number(cell.dataset.slot);
      if (!Number.isFinite(slot)) return null;
      // OUT OF A GEAR SLOT ONTO A CELL is both things at once: take it off, and
      // put it THERE. The host's take drops it back on the wall wherever there
      // is room, and the cell the player let go over is the one they meant — so
      // the move follows the action rather than replacing it.
      if (this.fromSlot) {
        const want = SLOT_ACTIONS[this.fromSlot].take;
        return offers(want) ? { host: cell, action: want, slot } : null;
      }
      return { host: cell, slot };
    }
    const grid = el.closest('.grid');
    if (grid && this.fromSlot) {
      const want = SLOT_ACTIONS[this.fromSlot].take;
      return offers(want) ? { host: grid, action: want } : null;
    }
    if (el.classList.contains('bs-scrim')) {
      return offers('drop') ? { host: el, action: 'drop' } : null;
    }
    return null;
  }

  private onPointerUp = (ev: PointerEvent): void => {
    if (!this.dragging) { this.press = null; return; }
    const id = this.dragging;
    // Read the target BEFORE tearing the ghost down: `endDrag` removes the
    // element `elementFromPoint` would otherwise have to see through anyway,
    // and clears the id this answer is about.
    const hit = this.dropTarget(document.elementFromPoint(ev.clientX, ev.clientY));
    this.endDrag();
    if (!hit) return;
    if (hit.action) this.run(id, hit.action);
    // Both, in that order, for a gear slot emptied onto a cell — see `dropTarget`.
    if (hit.slot !== undefined) this.move(id, hit.slot);
  };

  private onPointerCancel = (): void => { this.endDrag(); };

  /** Put the row in cell `slot`. No rule, no toast — see `InventoryHooks.onMove`. */
  private move(id: string, slot: number): void {
    this.hideTip();
    this.hooks.onMove(id, slot);
    if (!this.el) return;
    this.pendingFocus = `[data-sel="${id}"]`;
    this.render();
  }

  private endDrag(): void {
    this.press = null;
    this.dragging = null;
    this.fromSlot = null;
    this.ghost?.remove();
    this.ghost = null;
    this.el?.classList.remove('dragging');
    for (const n of this.el?.querySelectorAll('.drop-ok') ?? []) n.classList.remove('drop-ok');
  }

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

  /**
   * How far to jump for "the row below", in FOCUSABLE positions.
   *
   * Inside the wall that is a question about CELLS and not about list order,
   * and since issue #116 the two are different things: the player can leave a
   * hole anywhere, so the eleventh focusable after this one is no longer the box
   * directly underneath. This walks the drawn cells instead and lands on the
   * filled one nearest the cell above or below — a wall with gaps in it steps
   * the way it looks, and a wall with none behaves exactly as it did.
   *
   * Outside the wall (the tabs, the footer) it is one step, as before.
   */
  private rowStep(dir: -1 | 1): number {
    const here = document.activeElement as HTMLElement | null;
    if (!here?.classList.contains('slot') || here.dataset.slot === undefined) return dir;
    const from = this.focusables.indexOf(here as HTMLButtonElement);
    const cell = Number(here.dataset.slot);
    const want = cell + INV_COLS * dir;
    let best = INV_COLS * dir;
    let nearest = Infinity;
    for (let i = 0; i < this.focusables.length; i++) {
      const el = this.focusables[i];
      if (!el.classList.contains('slot') || el.dataset.slot === undefined) continue;
      const c = Number(el.dataset.slot);
      // It has to actually move that way: the nearest cell to the row below can
      // otherwise be one on this row, and the press would go nowhere.
      if (dir > 0 ? c <= cell : c >= cell) continue;
      const d = Math.abs(c - want);
      if (d < nearest) { nearest = d; best = i - from; }
    }
    return best;
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
    // without a press — but only for a box that HOLDS something, or arrowing
    // onto Salvage would change what Salvage is pointed at. A gear slot counts:
    // it is where an equipped row is selected from now that it is not on the
    // wall as well, and a pad has no other route to Unequip.
    const sel = el.dataset.sel;
    const box = el.classList.contains('slot') || el.dataset.gear !== undefined;
    if (sel !== undefined && box && sel !== this.selected) {
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
