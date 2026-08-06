import type { ItemDef, ItemKind } from './types';
import { tn } from '../i18n';

/**
 * The item catalogue and the player's bag.
 *
 * It began as the smallest thing that made the beast fetch rule mean something
 * — one currency, two stackables, a bag of counts — and issue #74 is what
 * actually reads more than that. The rule has not changed: a field is here
 * because a system reads it, and the systems now are the inventory panel (name,
 * blurb, icon, rarity), the gear slots (`power`), salvage (`salvage`), drop
 * (`kind === 'quest'` is the refusal) and use (`effect`). There is still no
 * weight, no stack cap and no durability, because nothing asks.
 *
 * IDS ARE KEYS; NAMES ARE DISPLAY. `SHARD_ID` is 'shard' and stays 'shard' — it
 * is what the drop table, the fetch rule and any future save file key on. The
 * currency's NAME lives in src/i18n/en.ts, where it now reads "Cubloons", and
 * renaming it again is an edit to that one file.
 */

export const SHARD_ID = 'shard';

/**
 * The prefix that makes a companion an inventory item.
 *
 * The issue asks for beasts to be "handled as inventory items of beast type",
 * and this is the whole of that: a beast's id in the panel is `beast:emberfox`,
 * derived from the roster on the way to the screen. It is NOT a bag entry and
 * must never become one — a beast's level, xp and learned skills live in its
 * `BeastActor`, and a count in a Map beside them would be a second, wrong
 * answer to "which beasts do I have". Same argument as the currency below.
 */
export const BEAST_ID_PREFIX = 'beast:';

export const ITEMS: Record<string, ItemDef> = {
  // The existing currency, given an entry so drops can be uniform. Colour
  // matches the shard mote that pickups.ts has always drawn (0x76eee0).
  [SHARD_ID]: { id: SHARD_ID, nameKey: 'item.shard', kind: 'currency', color: 0x76eee0 },
  // Two representative stackables. Warm/cool so a claimed drop is legible
  // against the terrain at a glance, and against each other in a screenshot.
  sunberry: {
    id: 'sunberry', nameKey: 'item.sunberry', kind: 'stackable', color: 0xff9a4d,
    descriptionKey: 'item.sunberry.desc', salvage: 1,
  },
  glowpebble: {
    id: 'glowpebble', nameKey: 'item.glowpebble', kind: 'stackable', color: 0x9fd8ff,
    descriptionKey: 'item.glowpebble.desc', salvage: 1,
  },

  // -- Weapons ---------------------------------------------------------------
  // Five shapes, one per icon in the atlas, and their `power` is what the gear
  // slot adds to `Player.attackStat` (base 14 — see player/index.ts). The
  // spread is deliberately narrow: this is the slot working, not a balance
  // pass, and the forge is what will decide a weapon's real numbers.
  'sword-iron': {
    id: 'sword-iron', nameKey: 'item.swordIron', kind: 'weapon', color: 0xc9d3dd,
    descriptionKey: 'item.swordIron.desc', icon: 'oneHandedSword',
    model: 'sword', rarity: 'common', power: 4, salvage: 6,
  },
  'greatsword-iron': {
    id: 'greatsword-iron', nameKey: 'item.greatswordIron', kind: 'weapon', color: 0xb7c3cf,
    descriptionKey: 'item.greatswordIron.desc', icon: 'largeSword',
    model: 'greatsword', rarity: 'rare', power: 8, salvage: 14,
  },
  'bow-ash': {
    id: 'bow-ash', nameKey: 'item.bowAsh', kind: 'weapon', color: 0xc08a4a,
    descriptionKey: 'item.bowAsh.desc', icon: 'bow',
    model: 'bow', rarity: 'common', power: 5, salvage: 8,
  },
  'scythe-reaper': {
    id: 'scythe-reaper', nameKey: 'item.scytheReaper', kind: 'weapon', color: 0xa9b6c4,
    descriptionKey: 'item.scytheReaper.desc', icon: 'scythe',
    model: 'scythe', rarity: 'legendary', power: 11, salvage: 26,
  },
  'dagger-quick': {
    id: 'dagger-quick', nameKey: 'item.daggerQuick', kind: 'weapon', color: 0xd0d8e0,
    descriptionKey: 'item.daggerQuick.desc', icon: 'dagger',
    model: 'dagger', rarity: 'common', power: 3, salvage: 5,
  },

  // -- Blueprints ------------------------------------------------------------
  // The forge's input, and the reason `maxPower` is a separate field from
  // `power`: a blueprint has no strength of its own, it has a BUDGET the player
  // fills with attribute voxels. Until the forge ships they are collectable and
  // inspectable, and the detail pane says so rather than offering a dead button.
  'bp-sword': {
    id: 'bp-sword', nameKey: 'item.bpSword', kind: 'blueprint', color: 0x3f9bff,
    descriptionKey: 'item.bp.desc', icon: 'oneHandedSwordBlueprint',
    rarity: 'common', maxPower: 12, salvage: 4,
  },
  'bp-greatsword': {
    id: 'bp-greatsword', nameKey: 'item.bpGreatsword', kind: 'blueprint', color: 0x3f9bff,
    descriptionKey: 'item.bp.desc', icon: 'largeSwordBlueprint',
    rarity: 'rare', maxPower: 20, salvage: 9,
  },
  'bp-bow': {
    id: 'bp-bow', nameKey: 'item.bpBow', kind: 'blueprint', color: 0x3f9bff,
    descriptionKey: 'item.bp.desc', icon: 'bowBlueprint',
    rarity: 'common', maxPower: 14, salvage: 5,
  },
  'bp-scythe': {
    id: 'bp-scythe', nameKey: 'item.bpScythe', kind: 'blueprint', color: 0x3f9bff,
    descriptionKey: 'item.bp.desc', icon: 'scytheBlueprint',
    rarity: 'legendary', maxPower: 26, salvage: 16,
  },
  'bp-dagger': {
    id: 'bp-dagger', nameKey: 'item.bpDagger', kind: 'blueprint', color: 0x3f9bff,
    descriptionKey: 'item.bp.desc', icon: 'daggerBlueprint',
    rarity: 'common', maxPower: 9, salvage: 3,
  },

  // -- Potions ---------------------------------------------------------------
  // One of each shape of effect the type allows, which is also the argument for
  // `ItemEffect` being a bag of terms: neither of these needs a name.
  'potion-mend': {
    id: 'potion-mend', nameKey: 'item.potionMend', kind: 'potion', color: 0x6ce2a0,
    descriptionKey: 'item.potionMend.desc', rarity: 'common',
    effect: { heal: 40 }, salvage: 2,
  },
  'potion-fury': {
    id: 'potion-fury', nameKey: 'item.potionFury', kind: 'potion', color: 0xff6a5c,
    descriptionKey: 'item.potionFury.desc', rarity: 'rare',
    effect: { attack: 10, seconds: 30 }, salvage: 4,
  },

  // -- Taming orbs -----------------------------------------------------------
  // Four tiers, and the only thing separating them mechanically is `orbTier`:
  // the odds table and every `EnemyCapture.minTier` floor read that one number
  // (see src/combat/taming.ts). No `power` and no `effect` — an orb deals no
  // damage and does nothing to the hero.
  //
  // THE PRICES ARE THE PROGRESSION. Nothing else gates a Master Orb: you fight
  // wild beasts for Cubloons and buy the tier you can afford, so the roughly
  // fourfold step between tiers is what makes going after a Boulderpup a
  // decision rather than a formality. `salvage` is a tenth of the price, which
  // is the ratio the rest of this catalogue already runs at.
  //
  // The colours are the four the issue names, and they tint BOTH the thrown
  // model and the bag glyph — one source, so the Greater Orb in your hand is the
  // same blue as the one in the panel.
  'orb-tame': {
    id: 'orb-tame', nameKey: 'item.orbTame', kind: 'orb', color: 0xe0453c,
    descriptionKey: 'item.orbTame.desc', rarity: 'common',
    orbTier: 1, storePrice: 60, salvage: 6,
  },
  'orb-greater': {
    id: 'orb-greater', nameKey: 'item.orbGreater', kind: 'orb', color: 0x3f8ce0,
    descriptionKey: 'item.orbGreater.desc', rarity: 'common',
    orbTier: 2, storePrice: 240, salvage: 24,
  },
  'orb-ultra': {
    id: 'orb-ultra', nameKey: 'item.orbUltra', kind: 'orb', color: 0x9a5fd0,
    descriptionKey: 'item.orbUltra.desc', rarity: 'rare',
    orbTier: 3, storePrice: 900, salvage: 90,
  },
  'orb-master': {
    id: 'orb-master', nameKey: 'item.orbMaster', kind: 'orb', color: 0x2b2f3a,
    descriptionKey: 'item.orbMaster.desc', rarity: 'legendary',
    orbTier: 4, storePrice: 3200, salvage: 320,
  },

  // -- Quest -----------------------------------------------------------------
  // Nothing in the shipped content hands this out yet — the seam is the
  // `item.give` action main.ts registers, which is where a dialogue turn-in
  // lands (see the NPC note in AGENTS.md). It is in the catalogue because the
  // panel's refusal to drop or salvage a quest item is a rule that needs
  // something to be true of, and `/give` reaches it today.
  'gain-token': {
    id: 'gain-token', nameKey: 'item.gainToken', kind: 'quest', color: 0xffd479,
    descriptionKey: 'item.gainToken.desc', rarity: 'rare',
  },
};

/** Loot table for the stackables (see CombatSystem.killEnemy). */
export const STACKABLE_IDS: readonly string[] =
  Object.values(ITEMS).filter((i) => i.kind === 'stackable').map((i) => i.id);

/**
 * The rare half of the drop table: what a kill can turn up that is not raw
 * stuff. Blueprints and potions only — a weapon is something you forge or are
 * given, and a quest item that fell off a gloopling is a quest item nobody
 * designed. main.ts owns the odds; this owns the pool.
 */
export const RARE_DROP_IDS: readonly string[] =
  Object.values(ITEMS)
    .filter((i) => i.kind === 'blueprint' || i.kind === 'potion')
    .map((i) => i.id);

/**
 * Every taming orb, weakest first — the shop's order and the readied-orb cycle's.
 *
 * Derived rather than listed for the reason `STACKABLE_IDS` is: the catalogue
 * above is where an orb is declared, and a second hand-written list of the four
 * would be a place to forget the fifth. Sorted on `orbTier` so "weakest first"
 * is a property of the data and not of where somebody typed the entry.
 */
export const ORB_IDS: readonly string[] =
  Object.values(ITEMS)
    .filter((i) => i.kind === 'orb')
    .sort((a, b) => (a.orbTier ?? 0) - (b.orbTier ?? 0))
    .map((i) => i.id);

/** Unknown ids fall back to the shard so a bad id can never crash a drop. */
export function itemDef(id: string): ItemDef {
  return ITEMS[id] ?? ITEMS[SHARD_ID];
}

/** True for an id the catalogue actually holds — `itemDef`'s fallback hides this. */
export function isKnownItem(id: string): boolean {
  return id in ITEMS;
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

/**
 * Whether the panel may destroy this — one predicate rather than two `kind`
 * tests at four call sites, because "a quest item cannot be thrown away" is a
 * rule and rules that are spelled out at each site get one site wrong.
 */
export function isDestructible(def: ItemDef): boolean {
  return def.kind !== 'quest' && def.kind !== 'currency';
}

/** Cubloons a salvage of one unit returns. 0 means the panel offers no button. */
export function salvageValue(def: ItemDef): number {
  return isDestructible(def) ? (def.salvage ?? 0) : 0;
}

export interface BagEntry {
  def: ItemDef;
  count: number;
}

/**
 * The player's inventory: everything with a COUNT.
 *
 * Two things are deliberately not in here, for the same reason. Currency is one
 * running total owned by combat and spent in main.ts — folding it in would have
 * made "do I already hold one of these?" answer yes for money too, which is the
 * fetch rule's whole question. And a BEAST is a `BeastActor` in the roster
 * carrying its own level and skills; the panel derives a `beast:` row from that
 * (see BEAST_ID_PREFIX) rather than storing a second copy that could disagree.
 *
 * Insertion order is preserved and IS the panel's order, so an item you just
 * picked up appears at the end rather than wherever a sort happened to put it.
 * `remove` therefore deletes an emptied key rather than leaving a zero behind,
 * or picking the last one up again would jump it back to its old place.
 */
export class Inventory {
  private stacks = new Map<string, number>();

  count(itemId: string): number {
    return this.stacks.get(itemId) ?? 0;
  }

  /** Empty it. What a new game starts with, and one of two ways things leave. */
  clear(): void {
    this.stacks.clear();
  }

  /** Returns the new stack size. */
  add(itemId: string, n = 1): number {
    const next = this.count(itemId) + n;
    this.stacks.set(itemId, next);
    return next;
  }

  /**
   * Take `n` away, or as many as are there. Returns how many actually left, so
   * a caller paying out for a salvage pays for what it removed and never for
   * a stack that was already gone.
   */
  remove(itemId: string, n = 1): number {
    const have = this.count(itemId);
    const took = Math.min(have, Math.max(0, n));
    if (took <= 0) return 0;
    if (took === have) this.stacks.delete(itemId);
    else this.stacks.set(itemId, have - took);
    return took;
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

  /** The same snapshot, narrowed to one kind. The panel's tabs are these. */
  entriesOfKind(kind: ItemKind): BagEntry[] {
    return this.entries().filter((e) => e.def.kind === kind);
  }
}
