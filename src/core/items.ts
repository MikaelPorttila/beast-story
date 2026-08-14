import type { ItemDef, ItemKind } from "./types";
import { tn } from "../i18n";

/** Ids are keys; display names live in i18n/en.ts. */

export const SHARD_ID = "shard";

/** A panel row derived from the roster — NEVER a bag entry. */
export const BEAST_ID_PREFIX = "beast:";

export const ITEMS: Record<string, ItemDef> = {
  // Colour matches the shard mote pickups.ts draws.
  [SHARD_ID]: { id: SHARD_ID, nameKey: "item.shard", kind: "currency", color: 0x76eee0 },
  sunberry: {
    id: "sunberry",
    nameKey: "item.sunberry",
    kind: "stackable",
    color: 0xff9a4d,
    descriptionKey: "item.sunberry.desc",
    salvage: 1,
  },
  glowpebble: {
    id: "glowpebble",
    nameKey: "item.glowpebble",
    kind: "stackable",
    color: 0x9fd8ff,
    descriptionKey: "item.glowpebble.desc",
    salvage: 1,
  },

  // `power` adds to `Player.attackStat` (base 14).
  "sword-iron": {
    id: "sword-iron",
    nameKey: "item.swordIron",
    kind: "weapon",
    color: 0xc9d3dd,
    descriptionKey: "item.swordIron.desc",
    icon: "oneHandedSword",
    model: "sword",
    rarity: "common",
    power: 4,
    salvage: 6,
  },
  "greatsword-iron": {
    id: "greatsword-iron",
    nameKey: "item.greatswordIron",
    kind: "weapon",
    color: 0xb7c3cf,
    descriptionKey: "item.greatswordIron.desc",
    icon: "largeSword",
    model: "greatsword",
    rarity: "rare",
    power: 8,
    salvage: 14,
  },
  "bow-ash": {
    id: "bow-ash",
    nameKey: "item.bowAsh",
    kind: "weapon",
    color: 0xc08a4a,
    descriptionKey: "item.bowAsh.desc",
    icon: "bow",
    model: "bow",
    rarity: "common",
    power: 5,
    salvage: 8,
  },
  "scythe-reaper": {
    id: "scythe-reaper",
    nameKey: "item.scytheReaper",
    kind: "weapon",
    color: 0xa9b6c4,
    descriptionKey: "item.scytheReaper.desc",
    icon: "scythe",
    model: "scythe",
    rarity: "legendary",
    power: 11,
    salvage: 26,
  },
  "dagger-quick": {
    id: "dagger-quick",
    nameKey: "item.daggerQuick",
    kind: "weapon",
    color: 0xd0d8e0,
    descriptionKey: "item.daggerQuick.desc",
    icon: "dagger",
    model: "dagger",
    rarity: "common",
    power: 3,
    salvage: 5,
  },

  // `maxPower` is a BUDGET the player fills, not a strength — hence not `power`.
  "bp-sword": {
    id: "bp-sword",
    nameKey: "item.bpSword",
    kind: "blueprint",
    color: 0x3f9bff,
    descriptionKey: "item.bp.desc",
    icon: "oneHandedSwordBlueprint",
    rarity: "common",
    maxPower: 12,
    salvage: 4,
  },
  "bp-greatsword": {
    id: "bp-greatsword",
    nameKey: "item.bpGreatsword",
    kind: "blueprint",
    color: 0x3f9bff,
    descriptionKey: "item.bp.desc",
    icon: "largeSwordBlueprint",
    rarity: "rare",
    maxPower: 20,
    salvage: 9,
  },
  "bp-bow": {
    id: "bp-bow",
    nameKey: "item.bpBow",
    kind: "blueprint",
    color: 0x3f9bff,
    descriptionKey: "item.bp.desc",
    icon: "bowBlueprint",
    rarity: "common",
    maxPower: 14,
    salvage: 5,
  },
  "bp-scythe": {
    id: "bp-scythe",
    nameKey: "item.bpScythe",
    kind: "blueprint",
    color: 0x3f9bff,
    descriptionKey: "item.bp.desc",
    icon: "scytheBlueprint",
    rarity: "legendary",
    maxPower: 26,
    salvage: 16,
  },
  "bp-dagger": {
    id: "bp-dagger",
    nameKey: "item.bpDagger",
    kind: "blueprint",
    color: 0x3f9bff,
    descriptionKey: "item.bp.desc",
    icon: "daggerBlueprint",
    rarity: "common",
    maxPower: 9,
    salvage: 3,
  },

  "potion-mend": {
    id: "potion-mend",
    nameKey: "item.potionMend",
    kind: "potion",
    color: 0x6ce2a0,
    descriptionKey: "item.potionMend.desc",
    rarity: "common",
    effect: { heal: 40 },
    salvage: 2,
  },
  "potion-fury": {
    id: "potion-fury",
    nameKey: "item.potionFury",
    kind: "potion",
    color: 0xff6a5c,
    descriptionKey: "item.potionFury.desc",
    rarity: "rare",
    effect: { attack: 10, seconds: 30 },
    salvage: 4,
  },

  // `orbTier` is the only mechanical difference (combat/taming.ts). Price is the
  // progression: roughly fourfold per tier, salvage a tenth of the price.
  "orb-tame": {
    id: "orb-tame",
    nameKey: "item.orbTame",
    kind: "orb",
    color: 0xe0453c,
    descriptionKey: "item.orbTame.desc",
    rarity: "common",
    orbTier: 1,
    storePrice: 60,
    salvage: 6,
  },
  "orb-greater": {
    id: "orb-greater",
    nameKey: "item.orbGreater",
    kind: "orb",
    color: 0x3f8ce0,
    descriptionKey: "item.orbGreater.desc",
    rarity: "common",
    orbTier: 2,
    storePrice: 240,
    salvage: 24,
  },
  "orb-ultra": {
    id: "orb-ultra",
    nameKey: "item.orbUltra",
    kind: "orb",
    color: 0x9a5fd0,
    descriptionKey: "item.orbUltra.desc",
    rarity: "rare",
    orbTier: 3,
    storePrice: 900,
    salvage: 90,
  },
  "orb-master": {
    id: "orb-master",
    nameKey: "item.orbMaster",
    kind: "orb",
    color: 0x2b2f3a,
    descriptionKey: "item.orbMaster.desc",
    rarity: "legendary",
    orbTier: 4,
    storePrice: 3200,
    salvage: 320,
  },

  // What was in the millrace under Redbriar (issue #150) — the first piece of
  // the instrument, and the first evidence that the corruption was MADE. A
  // `quest` item, so the bag will not let it be salvaged or dropped.
  "red-shard": {
    id: "red-shard",
    nameKey: "item.redShard",
    kind: "quest",
    color: 0xc4423c,
    descriptionKey: "item.redShard.desc",
    rarity: "rare",
  },

  // The drowned market's floor (issue #154): what the tide buried, dived for by
  // count, and the first of the three device parts the act assembles.
  salvage: {
    id: "salvage",
    nameKey: "item.salvage",
    kind: "quest",
    color: 0x8fb8a8,
    descriptionKey: "item.salvage.desc",
    rarity: "common",
  },
  "component-lens": {
    id: "component-lens",
    nameKey: "item.componentLens",
    kind: "quest",
    color: 0x9adfd2,
    descriptionKey: "item.componentLens.desc",
    rarity: "rare",
  },
  // The second device part (issue #155), salvaged from Corwin Vane's wreck.
  "component-vane": {
    id: "component-vane",
    nameKey: "item.componentVane",
    kind: "quest",
    color: 0xc9d3dd,
    descriptionKey: "item.componentVane.desc",
    rarity: "rare",
  },

  // Handed out via the `item.give` action; reachable today through `/give`.
  "gain-token": {
    id: "gain-token",
    nameKey: "item.gainToken",
    kind: "quest",
    color: 0xffd479,
    descriptionKey: "item.gainToken.desc",
    rarity: "rare",
  },
};

/** Loot table for the stackables (see CombatSystem.killEnemy). */
export const STACKABLE_IDS: readonly string[] = Object.values(ITEMS)
  .filter((i) => i.kind === "stackable")
  .map((i) => i.id);

/** The rare drop pool. main.ts owns the odds. */
export const RARE_DROP_IDS: readonly string[] = Object.values(ITEMS)
  .filter((i) => i.kind === "blueprint" || i.kind === "potion")
  .map((i) => i.id);

/** Every taming orb, weakest first: the shop's order and the readied-orb cycle's. */
export const ORB_IDS: readonly string[] = Object.values(ITEMS)
  .filter((i) => i.kind === "orb")
  .toSorted((a, b) => (a.orbTier ?? 0) - (b.orbTier ?? 0))
  .map((i) => i.id);

/** Unknown ids fall back to the shard so a bad id can never crash a drop. */
export function itemDef(id: string): ItemDef {
  return ITEMS[id] ?? ITEMS[SHARD_ID];
}

/** True for an id the catalogue actually holds — `itemDef`'s fallback hides this. */
export function isKnownItem(id: string): boolean {
  return id in ITEMS;
}

/** The only way anything should turn an item into text. Plural agrees with `count`. */
export function itemName(def: ItemDef, count = 1): string {
  return tn(def.nameKey, count);
}

export const CURRENCY: ItemDef = ITEMS[SHARD_ID];

/** Whether the panel may destroy this. One predicate, not a `kind` test per call site. */
export function isDestructible(def: ItemDef): boolean {
  return def.kind !== "quest" && def.kind !== "currency";
}

/** Cubloons a salvage of one unit returns. 0 means the panel offers no button. */
export function salvageValue(def: ItemDef): number {
  return isDestructible(def) ? (def.salvage ?? 0) : 0;
}

export interface BagEntry {
  def: ItemDef;
  count: number;
}

/** Insertion order drives `SlotLayout`, so `remove` deletes an emptied key. */
export class Inventory {
  private stacks = new Map<string, number>();

  count(itemId: string): number {
    return this.stacks.get(itemId) ?? 0;
  }

  clear(): void {
    this.stacks.clear();
  }

  add(itemId: string, n = 1): number {
    const next = this.count(itemId) + n;
    this.stacks.set(itemId, next);
    return next;
  }

  /** Returns how many actually left, so a salvage pays only for what it removed. */
  remove(itemId: string, n = 1): number {
    const have = this.count(itemId);
    const took = Math.min(have, Math.max(0, n));
    if (took <= 0) {
      return 0;
    }
    if (took === have) {
      this.stacks.delete(itemId);
    } else {
      this.stacks.set(itemId, have - took);
    }
    return took;
  }

  /** Allocates — call it when the bag CHANGES, never per frame. */
  entries(): BagEntry[] {
    const out: BagEntry[] = [];
    for (const [id, count] of this.stacks) {
      if (count > 0) {
        out.push({ def: itemDef(id), count });
      }
    }
    return out;
  }

  entriesOfKind(kind: ItemKind): BagEntry[] {
    return this.entries().filter((e) => e.def.kind === kind);
  }

  /** Save (issue #171). PAIRS IN ORDER: order drives slot layout. Ids validated on load. */
  toJSON(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const [id, count] of this.stacks) {
      if (count > 0) {
        out.push([id, count]);
      }
    }
    return out;
  }
}

/**
 * Panel cell per row (issue #116) — a new row takes the first free cell, then only the
 * player moves it. Holds `beast:` ids too; a slot is a position, never ownership.
 */
export class SlotLayout {
  private byId = new Map<string, number>();
  private atSlot = new Map<number, string>();

  slotOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  span(): number {
    let max = -1;
    for (const slot of this.atSlot.keys()) {
      if (slot > max) {
        max = slot;
      }
    }
    return max;
  }

  /** Forget rows that are gone, give new ones the first free cell. Per model build. */
  reconcile(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const id of Array.from(this.byId.keys())) {
      if (!live.has(id)) {
        this.release(id);
      }
    }
    for (const id of ids) {
      if (!this.byId.has(id)) {
        this.put(id, this.firstFree());
      }
    }
  }

  /** Dragged onto `slot`. An occupied cell SWAPS rather than pushing anything aside. */
  move(id: string, slot: number): void {
    if (slot < 0 || !this.byId.has(id)) {
      return;
    }
    const from = this.byId.get(id) as number;
    if (from === slot) {
      return;
    }
    const sitting = this.atSlot.get(slot);
    this.put(id, slot);
    if (sitting !== undefined) {
      this.put(sitting, from);
    } else {
      this.atSlot.delete(from);
    }
  }

  release(id: string): void {
    const slot = this.byId.get(id);
    if (slot === undefined) {
      return;
    }
    this.byId.delete(id);
    if (this.atSlot.get(slot) === id) {
      this.atSlot.delete(slot);
    }
  }

  clear(): void {
    this.byId.clear();
    this.atSlot.clear();
  }

  /** The wall, for a save (issue #171): every row and the cell it sits in. */
  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, slot] of this.byId) {
      out[id] = slot;
    }
    return out;
  }

  /** Restore. Stale entries are KEPT; `reconcile` forgets them. Restore this BEFORE the bag. */
  fromJSON(raw: Record<string, number>): void {
    this.clear();
    for (const id of Object.keys(raw)) {
      const slot = raw[id];
      if (Number.isInteger(slot) && slot >= 0) {
        this.put(id, slot);
      }
    }
  }

  private put(id: string, slot: number): void {
    this.byId.set(id, slot);
    this.atSlot.set(slot, id);
  }

  private firstFree(): number {
    let i = 0;
    while (this.atSlot.has(i)) {
      i++;
    }
    return i;
  }
}
