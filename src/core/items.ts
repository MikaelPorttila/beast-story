import type { ItemDef } from './types';
import { tn } from '../i18n';

/**
 * The item catalogue and the player's bag.
 *
 * This is deliberately the smallest thing that makes the pal fetch rule mean
 * something: one currency, two stackables, and a bag of counts. There is no
 * rarity, weight, stack cap, equipment slot or crafting input here, and none
 * should be added until a system actually reads it — the drop pool, the pal
 * errand and the HUD chip between them only need an id, a name key, a kind and
 * a colour.
 *
 * IDS ARE KEYS; NAMES ARE DISPLAY. `SHARD_ID` is 'shard' and stays 'shard' — it
 * is what the drop table, the fetch rule and any future save file key on. The
 * currency's NAME lives in src/i18n/en.ts, where it now reads "Cubloons", and
 * renaming it again is an edit to that one file.
 */

export const SHARD_ID = 'shard';

export const ITEMS: Record<string, ItemDef> = {
  // The existing currency, given an entry so drops can be uniform. Colour
  // matches the shard mote that pickups.ts has always drawn (0x76eee0).
  [SHARD_ID]: { id: SHARD_ID, nameKey: 'item.shard', kind: 'currency', color: 0x76eee0 },
  // Two representative stackables. Warm/cool so a claimed drop is legible
  // against the terrain at a glance, and against each other in a screenshot.
  sunberry: { id: 'sunberry', nameKey: 'item.sunberry', kind: 'stackable', color: 0xff9a4d },
  glowpebble: { id: 'glowpebble', nameKey: 'item.glowpebble', kind: 'stackable', color: 0x9fd8ff },
};

/** Loot table for the stackables (see CombatSystem.killEnemy). */
export const STACKABLE_IDS: readonly string[] =
  Object.values(ITEMS).filter((i) => i.kind === 'stackable').map((i) => i.id);

/** Unknown ids fall back to the shard so a bad id can never crash a drop. */
export function itemDef(id: string): ItemDef {
  return ITEMS[id] ?? ITEMS[SHARD_ID];
}

/**
 * The item's display name, in the form that matches `count` — "Cubloon" for
 * one, "Cubloons" for any other number. The ONLY way anything should turn an
 * item into text.
 *
 * Allocates nothing: the table entries carry no placeholder, so `tn` hands back
 * the stored string. Still, call it where a name is WRITTEN (a bag chip rebuild,
 * a toast), not once per frame for a label that has not changed.
 */
export function itemName(def: ItemDef, count = 1): string {
  return tn(def.nameKey, count);
}

/** The currency, for the HUD pill and anything else that names money. */
export const CURRENCY: ItemDef = ITEMS[SHARD_ID];

export interface BagEntry {
  def: ItemDef;
  count: number;
}

/**
 * The player's stackable inventory. Currency is NOT in here — the 'shard' item
 * (displayed as "Cubloons") is one running total owned by combat and spent in
 * main.ts, and folding it in would have made "do I already hold one of these?"
 * answer yes for money too.
 */
export class Inventory {
  private stacks = new Map<string, number>();

  count(itemId: string): number {
    return this.stacks.get(itemId) ?? 0;
  }

  /** Returns the new stack size. */
  add(itemId: string, n = 1): number {
    const next = this.count(itemId) + n;
    this.stacks.set(itemId, next);
    return next;
  }

  /**
   * Snapshot for the HUD. Allocates, so call it when the bag CHANGES, never
   * per frame — the HUD holds the rendered chips and only redraws on change.
   */
  entries(): BagEntry[] {
    const out: BagEntry[] = [];
    for (const [id, count] of this.stacks) {
      if (count > 0) out.push({ def: itemDef(id), count });
    }
    return out;
  }
}
