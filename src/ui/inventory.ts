import { t } from "../i18n";
import { MOUNT_KIND_KEYS, type BeastSpecies, type ItemKind, type MountKind } from "../core/types";
import { injectStyles } from "./styles";
import { CLOSE_ICON, LOCOMOTION_ICONS, RMB_ICON } from "./icons";
import { InventoryStage } from "./inventory-stage";
import { entryIconHtml, Tooltip, type TipContent } from "./tooltip";

/**
 * The inventory (issues #74, #116). Knows no game rules, only MAPS a gesture to an
 * action the host listed for that row. Drag is POINTER EVENTS, not HTML5 DnD:
 * rearranging needs a cell index, and `dragstart` never fires for pen or touch.
 */

/**
 * Re-taking pointer lock is only safe after some of these. With no keyboard lock
 * (Brave nulls `navigator.keyboard`) `escape` also leaves fullscreen and drops the
 * lock ~8 ms later, which a host that re-takes it reads as a second Escape.
 */
export type InvCloseBy = "escape" | "hotkey" | "click";

export type InvAction =
  | "equip"
  | "unequip"
  | "use"
  | "salvage"
  | "drop"
  | "forge"
  | "setLead"
  | "setSupport"
  | "ready"
  | "unready";

type ActionKey =
  | "inv.equip"
  | "inv.unequip"
  | "inv.use"
  | "inv.salvage"
  | "inv.drop"
  | "inv.forge"
  | "inv.setLead"
  | "inv.setSupport"
  | "inv.ready"
  | "inv.unready";

const ACTION_KEYS: Record<InvAction, ActionKey> = {
  equip: "inv.equip",
  unequip: "inv.unequip",
  use: "inv.use",
  salvage: "inv.salvage",
  drop: "inv.drop",
  forge: "inv.forge",
  setLead: "inv.setLead",
  setSupport: "inv.setSupport",
  // Own pair of words so the orb and weapon footer buttons stay distinguishable.
  ready: "inv.ready",
  unready: "inv.unready",
};

/** Never a row's primary, never a right-click or drag — footer buttons only. */
const DESTRUCTIVE: ReadonlySet<InvAction> = new Set<InvAction>(["salvage", "drop"]);

/** Both directions per slot, still gated on the host having listed the action. */
const SLOT_ACTIONS: Record<GearSlotId, { put: InvAction; take: InvAction }> = {
  weapon: { put: "equip", take: "unequip" },
  primary: { put: "setLead", take: "unequip" },
  support: { put: "setSupport", take: "unequip" },
  orb: { put: "ready", take: "unready" },
};

export type GearSlotId = "weapon" | "primary" | "support" | "orb";

/** HUD locomotion glyphs; the amphibious one is unused — no unlock is ambiguous. */
const MOUNT_ICONS: Record<MountKind, string> = {
  ground: LOCOMOTION_ICONS.ground,
  water: LOCOMOTION_ICONS.swimming,
  flying: LOCOMOTION_ICONS.flying,
};

const MOUNT_COLOR = 0x69d9ff;
const MOUNT_LOCKED_COLOR = 0x64748b;

export type { TipStat as InvStat } from "./tooltip";

/** Separate from `InvEntry` so a hoverable-only thing cannot acquire a gesture.
 *  The shape is the shared tooltip's (issue #246) — the journal feeds the same box. */
export type InvTip = TipContent;

export interface InvEntry extends InvTip {
  /** Item id, or `beast:<species>`. Round-tripped to the host untouched. */
  id: string;
  kind: ItemKind;
  /** Shown from 2 up. */
  count: number;
  /** A tile name in the weapon atlas. */
  icon?: string;
  /** `ItemDef.orbTier`, 1-4 — read only for the glyph's notch count. */
  orbTier?: number;
  /** Read only through the stage, which bakes the portrait. */
  species?: BeastSpecies;
  equipped?: boolean;
  /** Issue #116: the panel never sorts, packs or closes a hole. */
  slot?: number;
  actions?: readonly InvAction[];
}

export interface GearSlotView {
  slot: GearSlotId;
  entry: InvEntry | null;
}

/** All kinds every time, locked ones included. `kind` is never round-tripped. */
export interface MountBadgeView {
  kind: MountKind;
  unlocked: boolean;
}

export interface InventoryModel {
  gear: readonly GearSlotView[];
  entries: readonly InvEntry[];
  mounts: readonly MountBadgeView[];
}

export interface InventoryHooks {
  model: () => InventoryModel;
  onAction: (id: string, action: InvAction) => void;
  /** Not an `InvAction`: carries a number, changes no game state. See `InvEntry.slot`. */
  onMove: (id: string, slot: number) => void;
  onOpen?: () => void;
  onClose?: (by: InvCloseBy) => void;
}

const TABS: readonly { id: ItemKind | null; key: string }[] = [
  { id: null, key: "inv.tab.all" },
  { id: "beast", key: "inv.tab.beast" },
  { id: "weapon", key: "inv.tab.weapon" },
  { id: "orb", key: "inv.tab.orb" },
  { id: "blueprint", key: "inv.tab.blueprint" },
  { id: "potion", key: "inv.tab.potion" },
  { id: "stackable", key: "inv.tab.stackable" },
  { id: "quest", key: "inv.tab.quest" },
];

/**
 * `INV_COLS` is BOTH the stylesheet's `--cols` and the keyboard's up/down step, so
 * narrowing one in a media query would silently skip slots (issue #116).
 */
export const INV_COLS = 11;
export const INV_ROWS = 3;

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"])';

/** Travel before a RELEASE counts — 5px, since a shaky click moves one or two. */
const DRAG_SLOP = 5;

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const hexColor = (c: number): string => "#" + c.toString(16).padStart(6, "0");

/** Built here, not by the host: the strings come from the kind itself. */
function mountTip(m: MountBadgeView): InvTip {
  const keys = MOUNT_KIND_KEYS[m.kind];
  return {
    name: t(keys.name),
    color: m.unlocked ? MOUNT_COLOR : MOUNT_LOCKED_COLOR,
    description: t(keys.desc),
    note: t(m.unlocked ? "inv.mount.unlocked" : "inv.mount.locked"),
  };
}

const SLOT_LABELS: Record<
  GearSlotId,
  "inv.slot.weapon" | "inv.slot.primary" | "inv.slot.support" | "inv.slot.orb"
> = {
  weapon: "inv.slot.weapon",
  primary: "inv.slot.primary",
  support: "inv.slot.support",
  orb: "inv.slot.orb",
};

export class InventoryPanel {
  private el: HTMLDivElement | null = null;
  private tip = new Tooltip();
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
  private dragging: string | null = null;
  private pickX = 0;
  private pickY = 0;
  /** Past the slop a release puts the row down; under it the row stays in hand. */
  private travelled = false;
  /** The slot, not a boolean — what a drag OUT means is per-slot (`SLOT_ACTIONS`). */
  private fromSlot: GearSlotId | null = null;
  /** The box under the cursor while one is in the air; never a drop target. */
  private ghost: HTMLDivElement | null = null;
  /** Suppresses the `click` the browser fires at the end of a drag. */
  private dragged = false;
  private rows = new Map<string, InvEntry>();
  /** Hoverable non-rows, keyed by kind. Kept out of `rows` so they stay undraggable. */
  private tips = new Map<string, InvTip>();
  private stage = new InventoryStage();

  /** A second listener on the bake (issue #246): the journal patches its own tip. */
  onPortrait: ((speciesId: string, url: string) => void) | null = null;

  constructor(private hooks: InventoryHooks) {
    injectStyles();
    // Patch, not render: a rebuild per portrait would move the keyboard cursor.
    this.stage.onIcon = (id, url) => {
      this.paintIcon(id, url);
      this.onPortrait?.(id, url);
    };
  }

  /**
   * The baked portrait for a species, queueing a bake when there is none yet —
   * the journal's tips read the same cache the slots do. The bake completes
   * even with this panel closed (`InventoryStage.requestIcon`'s pump).
   */
  beastIcon(sp: BeastSpecies): string | null {
    return this.stage.requestIcon(sp);
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(): void {
    if (this.el) {
      return;
    }
    const el = document.createElement("div");
    el.className = "bs-inv";
    el.innerHTML = '<div class="bs-scrim"></div><aside class="pane bs-glass"></aside>';
    this.el = el;
    this.tip.attach(el);
    document.body.appendChild(el);
    el.addEventListener("click", this.onClick);
    el.addEventListener("contextmenu", this.onContextMenu);
    el.addEventListener("pointerover", this.onPointerOver);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerout", this.onPointerOut);
    el.addEventListener("pointerdown", this.onPointerDown);
    // On the WINDOW: a drag ending over the browser chrome must still let go.
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize);
    this.render();
    this.pollPad();
    this.stage.start();
    requestAnimationFrame(() => el.classList.add("open"));
    this.hooks.onOpen?.();
  }

  close(by: InvCloseBy = "click"): void {
    if (!this.el) {
      return;
    }
    if (this.padRaf) {
      cancelAnimationFrame(this.padRaf);
    }
    this.padRaf = 0;
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onResize);
    // Stopped, not disposed: the GL context and baked portraits make reopen instant.
    this.stage.stop();
    this.padDown.fill(0);
    this.endDrag();
    this.tip.detach();
    this.el.remove();
    this.el = null;
    this.focusables = [];
    this.hooks.onClose?.(by);
  }

  toggle(): void {
    if (this.el) {
      this.close("hotkey");
    } else {
      this.open();
    }
  }

  /** For the probe. */
  stageCast(): (string | null)[] {
    return this.stage.castIds();
  }

  /** Called open or shut — the stage outlives the panel and must be right on reopen. */
  setHeroWeapon(model: string | null | undefined): void {
    this.stage.setHeroWeapon(model);
    if (this.el) {
      this.render();
    }
  }

  /** `item.give` can change the bag behind the modal. */
  refresh(): void {
    if (this.el) {
      this.render();
    }
  }

  /** Returns whether this panel SPENT the cancel, so one Escape closes one thing. */
  onEscape(): boolean {
    if (!this.el) {
      return false;
    }
    // A row in hand is the topmost thing: the first Escape puts it back.
    if (this.dragging) {
      this.endDrag();
      this.render();
      return true;
    }
    this.close("escape");
    return true;
  }

  dispose(): void {
    this.close();
    this.stage.dispose();
  }

  private render(): void {
    const el = this.el;
    if (!el) {
      return;
    }
    const model = this.hooks.model();
    const pane = el.querySelector(".pane") as HTMLElement;

    this.rows.clear();
    for (const e of model.entries) {
      this.rows.set(e.id, e);
    }
    for (const g of model.gear) {
      if (g.entry) {
        this.rows.set(g.entry.id, g.entry);
      }
    }
    this.tips.clear();
    for (const m of model.mounts) {
      this.tips.set(m.kind, mountTip(m));
    }

    const cells = this.wall(model.entries);
    const shown = (e: InvEntry | null): boolean =>
      e !== null && (this.tab === null || e.kind === this.tab);
    const list = cells.filter((e) => shown(e)) as InvEntry[];
    // The selection may be in a gear slot: the footer is the only route to Unequip.
    let sel =
      this.selected === null
        ? null
        : (list.find((e) => e.id === this.selected) ??
          model.gear.find((g) => g.entry?.id === this.selected)?.entry ??
          null);
    if (!sel) {
      sel = list[0] ?? null;
    }
    this.selected = sel?.id ?? null;

    // Detaches the stage canvas, which keeps its GL context; `stage.mount` re-appends.
    pane.innerHTML =
      `<div class="head"><h2>${escapeHtml(t("inv.title"))}</h2></div>` +
      '<div class="stage"></div>' +
      this.gearHtml(model.gear) +
      this.mountsHtml(model.mounts) +
      this.tabsHtml() +
      `<div class="grid" style="--cols:${INV_COLS}">${
        // A row the tab filter hides still OWNS its cell: drawn empty, takes no drop.
        cells
          .map((e, i) =>
            shown(e)
              ? this.slotHtml(e as InvEntry, i)
              : `<div class="slot empty${e ? " held" : ""}"${e ? "" : ` data-slot="${i}"`}></div>`,
          )
          .join("")
      }</div>` +
      this.footHtml(sel);

    // `.cap` is hidden where there is no keyboard — media query in ui/styles.ts.
    const head = pane.querySelector(".head") as HTMLElement;
    head.insertAdjacentHTML("beforeend", `<span class="cap">${kbd("I")}${kbd("Esc")}</span>`);
    const closeBtn = document.createElement("button");
    closeBtn.className = "bs-shop-x";
    closeBtn.type = "button";
    closeBtn.dataset.act = "close";
    closeBtn.innerHTML = CLOSE_ICON;
    head.appendChild(closeBtn);

    const cast = model.gear;
    this.stage.mount(pane.querySelector(".stage") as HTMLElement);
    this.stage.setCast(
      cast.find((g) => g.slot === "primary")?.entry?.species ?? null,
      cast.find((g) => g.slot === "support")?.entry?.species ?? null,
    );
    // After layout: the canvas is in a flex row and has no size until then.
    requestAnimationFrame(() => this.stage.resize());

    this.focusables = Array.from(pane.querySelectorAll(FOCUSABLE));
    const want = this.pendingFocus;
    this.pendingFocus = null;
    const found = want ? pane.querySelector<HTMLButtonElement>(want) : null;
    this.focusIdx = found ? Math.max(0, this.focusables.indexOf(found)) : 0;
    this.focusables[this.focusIdx]?.focus();
  }

  /** Order matches the stage figures above; the orb is last, nobody stands over it. */
  private gearHtml(gear: readonly GearSlotView[]): string {
    const order: GearSlotId[] = ["primary", "weapon", "support", "orb"];
    return (
      '<div class="gear">' +
      order
        .map((slot) => {
          const e = gear.find((g) => g.slot === slot)?.entry ?? null;
          const cls = ["gs"];
          if (e) {
            cls.push("full");
          }
          if (e?.rarity) {
            cls.push(`r-${e.rarity}`);
          }
          if (e && e.id === this.selected) {
            cls.push("sel");
          }
          return (
            `<button class="${cls.join(" ")}" type="button" data-gear="${slot}"` +
            (e ? ` data-sel="${escapeHtml(e.id)}"` : "") +
            ` style="--el:${hexColor(e?.color ?? 0x64748b)}">` +
            `<span class="gs-ic">${e ? this.iconHtml(e) : ""}</span>` +
            // The slot's ROLE, not the item's name — a varying label made slots jostle.
            `<span class="gs-l">${escapeHtml(t(SLOT_LABELS[slot]))}</span>` +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /**
   * NOT buttons: `div`s, so `onClick` (needs a `<button>`) and `onPointerDown`
   * (needs a `data-sel`) both skip them. `aria-label` replaces the tooltip.
   */
  private mountsHtml(mounts: readonly MountBadgeView[]): string {
    return (
      `<div class="mounts" role="group" aria-label="${escapeHtml(t("inv.mounts"))}">` +
      mounts
        .map((m) => {
          const tip = mountTip(m);
          return (
            `<div class="mt${m.unlocked ? " on" : ""}" data-tip="${m.kind}"` +
            ` style="--el:${hexColor(m.unlocked ? MOUNT_COLOR : MOUNT_LOCKED_COLOR)}"` +
            // The tooltip's own two lines, joined — same text for a screen reader.
            ` aria-label="${escapeHtml(`${tip.name} — ${tip.note ?? ""}`)}">` +
            `<i class="ic glyph">${MOUNT_ICONS[m.kind]}</i>` +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  private tabsHtml(): string {
    return `<div class="tabs strip" role="tablist" data-group="tab">${TABS.map((tb) => {
      const on = tb.id === this.tab;
      return (
        `<button class="chip tab${on ? " on" : ""}" type="button" role="tab"` +
        ` data-tab="${tb.id ?? "all"}" aria-selected="${on}"${on ? "" : ' tabindex="-1"'}>` +
        `${escapeHtml(t(tb.key as "inv.tab.all"))}</button>`
      );
    }).join("")}</div>`;
  }

  /**
   * Preference order: baked portrait, atlas tile, orb glyph, lozenge. `data-beast`
   * is what `paintIcon` patches; the orb is SVG for its notch count and colour.
   */
  private iconHtml(e: InvEntry): string {
    return entryIconHtml({
      color: e.color,
      kind: e.kind,
      icon: e.icon,
      orbTier: e.orbTier,
      speciesId: e.species?.id,
      iconUrl: e.species ? this.stage.iconFor(e.species) : undefined,
    });
  }

  private paintIcon(speciesId: string, url: string): void {
    const el = this.el;
    if (!el) {
      return;
    }
    for (const i of el.querySelectorAll<HTMLElement>(`.ic.beast[data-beast="${speciesId}"]`)) {
      i.style.backgroundImage = `url(${url})`;
      i.classList.remove("blob");
    }
  }

  /**
   * Length is the fixed 33 or the furthest claimed cell, so nothing is hidden. A row
   * with no free `slot` falls into the first empty cell rather than being dropped.
   */
  private wall(entries: readonly InvEntry[]): (InvEntry | null)[] {
    let span = INV_COLS * INV_ROWS;
    for (const e of entries) {
      if (e.slot !== undefined && e.slot + 1 > span) {
        span = e.slot + 1;
      }
    }
    const cells: (InvEntry | null)[] = Array.from<InvEntry | null>({
      length: Math.ceil(span / INV_COLS) * INV_COLS,
    }).fill(null);
    const spare: InvEntry[] = [];
    for (const e of entries) {
      if (e.slot !== undefined && e.slot >= 0 && cells[e.slot] === null) {
        cells[e.slot] = e;
      } else {
        spare.push(e);
      }
    }
    for (const e of spare) {
      const i = cells.indexOf(null);
      if (i < 0) {
        cells.push(e);
      } else {
        cells[i] = e;
      }
    }
    return cells;
  }

  private slotHtml(e: InvEntry, cell: number): string {
    const cls = ["slot"];
    if (e.rarity) {
      cls.push(`r-${e.rarity}`);
    }
    if (e.equipped) {
      cls.push("on");
    }
    if (e.id === this.selected) {
      cls.push("sel");
    }
    return (
      `<button class="${cls.join(" ")}" type="button" data-slot="${cell}"` +
      ` data-sel="${escapeHtml(e.id)}" style="--el:${hexColor(e.color)}">` +
      this.iconHtml(e) +
      (e.count > 1 ? `<span class="n">${e.count}</span>` : "") +
      "</button>"
    );
  }

  /**
   * A button for EVERY action the host offered (issue #116), on every device. Only
   * the primary wears the mouse glyph, being the only one also bound to a control.
   */
  private footHtml(sel: InvEntry | null): string {
    if (!sel) {
      return '<div class="sel"></div>';
    }
    const all = sel.actions ?? [];
    const primary = this.primaryOf(sel);
    const button = (a: InvAction, cls: string, bound: boolean): string =>
      `<button class="bs-buy ${cls}" type="button" data-do="${a}">` +
      (bound ? `<i class="cap">${RMB_ICON}</i>` : "") +
      `<span>${escapeHtml(t(ACTION_KEYS[a]))}</span></button>`;
    return (
      '<div class="sel">' +
      `<span class="nm">${escapeHtml(sel.name)}</span>` +
      all
        .map((a) =>
          a === primary
            ? button(a, "ghost", true)
            : DESTRUCTIVE.has(a)
              ? button(a, "danger", false)
              : button(a, "ghost", false),
        )
        .join("") +
      "</div>"
    );
  }

  private entryAt(target: EventTarget | null): InvEntry | null {
    const btn = (target as HTMLElement | null)?.closest?.("[data-sel]") as HTMLElement | null;
    const id = btn?.dataset.sel;
    return id ? (this.rows.get(id) ?? null) : null;
  }

  /** For the TOOLTIP only. */
  private tipAt(target: EventTarget | null): InvTip | null {
    const row = this.entryAt(target);
    if (row) {
      return row;
    }
    const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
    const key = el?.dataset.tip;
    return key ? (this.tips.get(key) ?? null) : null;
  }

  private onPointerOver = (ev: PointerEvent): void => {
    if (this.dragging) {
      return;
    } // the box in the air is what is being read
    const e = this.tipAt(ev.target);
    if (e) {
      this.tip.show(e, ev.clientX, ev.clientY);
    } else {
      this.tip.hide();
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.dragging) {
      if (
        !this.travelled &&
        Math.hypot(ev.clientX - this.pickX, ev.clientY - this.pickY) > DRAG_SLOP
      ) {
        this.travelled = true;
      }
      this.dragTo(ev.clientX, ev.clientY);
      return;
    }
    if (this.tip.visible) {
      this.tip.move(ev.clientX, ev.clientY);
    }
  };

  private onPointerOut = (ev: PointerEvent): void => {
    if (!this.tipAt(ev.relatedTarget)) {
      this.tip.hide();
    }
  };

  /** The row's PRIMARY action: the first one that does not destroy it. */
  private primaryOf(e: InvEntry): InvAction | null {
    return (e.actions ?? []).find((a) => !DESTRUCTIVE.has(a)) ?? null;
  }

  private run(id: string, action: InvAction, focus?: string): void {
    this.tip.hide();
    this.hooks.onAction(id, action);
    if (!this.el) {
      return;
    } // the host may have closed us from inside the action
    this.pendingFocus = focus ?? `[data-sel="${id}"]`;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (!target || !this.el) {
      return;
    }
    // The browser fires a click at the end of a drag too, on the shared ancestor.
    if (this.dragged) {
      this.dragged = false;
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

    const tab = btn.dataset.tab;
    if (tab !== undefined) {
      this.showTab(tab === "all" ? null : (tab as ItemKind));
      return;
    }

    const act = btn.dataset.do as InvAction | undefined;
    if (act && this.selected) {
      this.run(this.selected, act, `[data-do="${act}"]`);
      return;
    }

    // A left click only SELECTS — nothing destructive is one click from anything.
    const sel = btn.dataset.sel;
    if (sel !== undefined) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
    }
  };

  private onContextMenu = (ev: MouseEvent): void => {
    // Carrying: the right button puts the row back — the other way out, beside Escape.
    if (this.dragging) {
      ev.preventDefault();
      this.endDrag();
      this.render();
      return;
    }
    const e = this.entryAt(ev.target);
    if (!e) {
      return;
    }
    // Always, even with no action: the browser menu is never what that press meant.
    ev.preventDefault();
    const a = this.primaryOf(e);
    if (a) {
      this.run(e.id, a);
    }
  };

  /**
   * A left press picks up at once (issue #116) and also SELECTS. Hold-and-drag past
   * `DRAG_SLOP` or click-and-click, both ending in `resolve`. Touch is excluded:
   * the wall scrolls, and the footer covers every action.
   */
  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || ev.pointerType === "touch") {
      return;
    }
    // Carrying: this press is the put-down, so the click behind it means nothing.
    if (this.dragging) {
      this.dragged = true;
      this.resolve(ev.clientX, ev.clientY, true);
      return;
    }
    // Cleared here too: a drag ending off the window fires no click to clear it.
    this.dragged = false;
    const btn = (ev.target as HTMLElement | null)?.closest?.("[data-sel]") as HTMLElement | null;
    const id = btn?.dataset.sel;
    if (!btn || !id || !this.rows.has(id)) {
      return;
    }
    this.beginDrag(id, (btn.dataset.gear as GearSlotId | undefined) ?? null, ev);
  };

  private beginDrag(id: string, slot: GearSlotId | null, ev: PointerEvent): void {
    const e = this.rows.get(id);
    if (!e || !this.el) {
      return;
    }
    this.dragging = id;
    this.fromSlot = slot;
    this.pickX = ev.clientX;
    this.pickY = ev.clientY;
    this.travelled = false;
    this.dragged = true;
    this.selected = id;
    this.tip.hide();
    // Safe before the ghost: `render` rebuilds the PANE, the ghost hangs off the root.
    this.pendingFocus = `[data-sel="${id}"]`;
    this.render();
    this.el.classList.add("dragging");
    // `pointer-events:none` on `.drag-ghost` is load-bearing: `elementFromPoint` reads through it.
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.style.setProperty("--el", hexColor(e.color));
    ghost.innerHTML = this.iconHtml(e);
    this.el.appendChild(ghost);
    this.ghost = ghost;
    this.dragTo(ev.clientX, ev.clientY);
  }

  private dragTo(x: number, y: number): void {
    if (this.ghost) {
      this.ghost.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    }
    for (const n of this.el?.querySelectorAll(".drop-ok") ?? []) {
      n.classList.remove("drop-ok");
    }
    this.dropTarget(document.elementFromPoint(x, y))?.host.classList.add("drop-ok");
  }

  /**
   * Both directions come from `SLOT_ACTIONS`, gated on the host having listed the
   * action. The wall is a `take` out of a slot and a MOVE off itself; scrim = world.
   */
  private dropTarget(node: Element | null): {
    host: Element;
    action?: InvAction;
    slot?: number;
  } | null {
    const e = this.dragging ? this.rows.get(this.dragging) : null;
    const el = node as HTMLElement | null;
    if (!e || !el) {
      return null;
    }
    // Named `offers`, not `has`: test-keybinds.mjs scans for a member called
    // `has` taking a quoted literal and would read it as an undocumented key.
    const offers = (a: InvAction): boolean => (e.actions ?? []).includes(a);

    const gear = el.closest("[data-gear]") as HTMLElement | null;
    if (gear) {
      const want = SLOT_ACTIONS[gear.dataset.gear as GearSlotId].put;
      return offers(want) ? { host: gear, action: want } : null;
    }
    const cell = el.closest("[data-slot]") as HTMLElement | null;
    if (cell) {
      const slot = Number(cell.dataset.slot);
      if (!Number.isFinite(slot)) {
        return null;
      }
      // Gear slot onto a cell is both: take it off, then move it THERE.
      if (this.fromSlot) {
        const want = SLOT_ACTIONS[this.fromSlot].take;
        return offers(want) ? { host: cell, action: want, slot } : null;
      }
      return { host: cell, slot };
    }
    const grid = el.closest(".grid");
    if (grid && this.fromSlot) {
      const want = SLOT_ACTIONS[this.fromSlot].take;
      return offers(want) ? { host: grid, action: want } : null;
    }
    if (el.classList.contains("bs-scrim")) {
      return offers("drop") ? { host: el, action: "drop" } : null;
    }
    return null;
  }

  /** A release only counts if the pointer went somewhere — see `onPointerDown`. */
  private onPointerUp = (ev: PointerEvent): void => {
    if (!this.dragging || !this.travelled) {
      return;
    }
    this.resolve(ev.clientX, ev.clientY, false);
  };

  /**
   * The ONE place a drop is decided. `sticky` (a click, not the end of a drag) costs
   * the scrim its `drop`, since a click there also dismisses the panel.
   */
  private resolve(x: number, y: number, sticky: boolean): void {
    const id = this.dragging;
    if (!id) {
      return;
    }
    // Read the target BEFORE `endDrag`, which clears the id this answer is about.
    const node = document.elementFromPoint(x, y);
    const hit =
      sticky && (node as HTMLElement | null)?.classList.contains("bs-scrim")
        ? null
        : this.dropTarget(node);
    this.endDrag();
    if (!hit) {
      this.render();
      return;
    }
    if (hit.action) {
      this.run(id, hit.action);
    }
    // Both, in that order, for a gear slot emptied onto a cell.
    if (hit.slot !== undefined) {
      this.move(id, hit.slot);
    }
  }

  private onPointerCancel = (): void => {
    this.endDrag();
  };

  private move(id: string, slot: number): void {
    this.tip.hide();
    this.hooks.onMove(id, slot);
    if (!this.el) {
      return;
    }
    this.pendingFocus = `[data-sel="${id}"]`;
    this.render();
  }

  private endDrag(): void {
    this.dragging = null;
    this.fromSlot = null;
    this.travelled = false;
    this.ghost?.remove();
    this.ghost = null;
    this.el?.classList.remove("dragging");
    for (const n of this.el?.querySelectorAll(".drop-ok") ?? []) {
      n.classList.remove("drop-ok");
    }
  }

  private showTab(tab: ItemKind | null): void {
    this.tab = tab;
    this.pendingFocus = `[data-tab="${tab ?? "all"}"]`;
    this.render();
  }

  private onResize = (): void => {
    this.stage.resize();
  };

  /** Escape and `KeyI` are NOT read here — the host owns those edges for all devices. */
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
        this.moveFocus(this.rowStep(1));
        break;
      case "ArrowUp":
        ev.preventDefault();
        this.moveFocus(this.rowStep(-1));
        break;
      case "Enter": {
        const here = document.activeElement as HTMLElement | null;
        // Only a SLOT — a tab or footer button keeps the platform's own click.
        if (!here?.dataset.sel) {
          return;
        }
        const e = this.rows.get(here.dataset.sel);
        const a = e ? this.primaryOf(e) : null;
        if (e && a) {
          ev.preventDefault();
          this.run(e.id, a);
        }
        break;
      }
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

  /**
   * "The row below" in FOCUSABLE positions. Holes (issue #116) mean the 11th
   * focusable is not the box underneath, so it walks CELLS. One step outside the wall.
   */
  private rowStep(dir: -1 | 1): number {
    const here = document.activeElement as HTMLElement | null;
    if (!here?.classList.contains("slot") || here.dataset.slot === undefined) {
      return dir;
    }
    const from = this.focusables.indexOf(here as HTMLButtonElement);
    const cell = Number(here.dataset.slot);
    const want = cell + INV_COLS * dir;
    let best = INV_COLS * dir;
    let nearest = Infinity;
    for (let i = 0; i < this.focusables.length; i++) {
      const el = this.focusables[i];
      if (!el.classList.contains("slot") || el.dataset.slot === undefined) {
        continue;
      }
      const c = Number(el.dataset.slot);
      // Must actually move that way, or the nearest cell can be one on this row.
      if (dir > 0 ? c <= cell : c >= cell) {
        continue;
      }
      const d = Math.abs(c - want);
      if (d < nearest) {
        nearest = d;
        best = i - from;
      }
    }
    return best;
  }

  moveFocus(d: number): void {
    if (!this.focusables.length) {
      return;
    }
    const here = this.focusables.indexOf(document.activeElement as HTMLButtonElement);
    const from = here >= 0 ? here : this.focusIdx;
    const n = this.focusables.length;
    // Clamped for a multi-stop jump, wrapped for a single step, so a down-arrow on
    // the last half-row lands on the last slot rather than springing to the tabs.
    let next = from + d;
    if (Math.abs(d) > 1) {
      next = Math.min(n - 1, Math.max(0, next));
    } else {
      next = (next + n) % n;
    }
    this.focusIdx = next;
    const el = this.focusables[this.focusIdx];
    el.focus();
    // Only over a box that HOLDS something, or arrowing onto Salvage repoints it.
    const sel = el.dataset.sel;
    const box = el.classList.contains("slot") || el.dataset.gear !== undefined;
    if (sel !== undefined && box && sel !== this.selected) {
      this.selected = sel;
      this.pendingFocus = `[data-sel="${sel}"]`;
      this.render();
    }
  }

  activate(): void {
    const here = document.activeElement as HTMLButtonElement | null;
    const id = here?.dataset.sel;
    const e = id ? this.rows.get(id) : null;
    const a = e && here?.classList.contains("slot") ? this.primaryOf(e) : null;
    if (e && a) {
      this.run(e.id, a);
    } else {
      here?.click();
    }
  }

  /** See `PauseMenu.pollPad`. */
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
      this.moveFocus(this.rowStep(moveY as -1 | 1));
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

/** Restated rather than imported from ui/index.ts, which would pull in the HUD. */
function kbd(s: string): string {
  return `<kbd>${escapeHtml(s)}</kbd>`;
}
