/**
 * THE DEBUG SPAWNER'S MODEL — what can be conjured, and where it lands.
 *
 * Same split as `core/gfx.ts` next door, and for the same reason: this file
 * knows that a spawn has a branch, a name and a destination, and it knows
 * nothing about a bag, a party roster, an `Enemy` or a `StructureField`. The
 * composition root (main.ts) hands over the branches and the one function that
 * makes a click real, exactly as it hands `Gfx` its sinks.
 *
 * WHY THE BRANCHES ARE A FUNCTION AND NOT A CONSTANT. Two of the four move
 * under the game's feet. `enemySpecies()` is resolved from the frozen content
 * view, so `/content load` and `/content release` change what exists; and the
 * beast branch's rows are marked with what is already bonded. A list captured
 * at construction would be a list that went stale the first time either
 * happened — so the panel asks again every time it draws.
 *
 * WHY A SPAWN RETURNS A STRING. It is the same contract `ConsoleCommand.run`
 * has, and it is what lets the panel show "Ember Cloak x1" under the tree
 * without knowing that an item has a plural form or that currency is not in the
 * bag at all. The host already had to compose that sentence for `/give`; this
 * reuses it rather than teaching a second surface the same rules.
 */
import type { StringKey } from '../i18n';

/** Where a branch's rows end up. Purely a label for the reader — see `SpawnBranch`. */
export type SpawnTarget = 'bag' | 'party' | 'world';

export interface SpawnRow {
  /** Stable id, passed straight back to `spawn`. An item id, a species id, a part name. */
  id: string;
  /** What the row reads as. Already localised by the host — see the note above. */
  label: string;
  /**
   * Extra text the search matches but the row does not show: the raw id, an
   * item's kind, a species' element. It is what makes typing "potion" find
   * three things whose names never contain the word.
   */
  hint?: string;
  /** True for a row whose effect has already happened — a bonded beast. Shown greyed. */
  had?: boolean;
}

export interface SpawnBranch {
  id: string;
  labelKey: StringKey;
  /** One line under the heading saying where these land. */
  noteKey: StringKey;
  target: SpawnTarget;
  rows: readonly SpawnRow[];
}

export interface SpawnCatalogue {
  /** Every branch, re-derived. Called on each draw — see the note at the top. */
  branches(): readonly SpawnBranch[];
  /** Make one row real. Returns a line to show, or an error line. */
  spawn(branchId: string, rowId: string): string;
}

/**
 * Does this row match what was typed?
 *
 * Case-folded substring over the label and the hint, on whitespace-separated
 * terms that must ALL hit — so "red potion" finds the red one and not every
 * potion. Deliberately not fuzzy: a debug list of ninety known ids rewards
 * exactness, and a fuzzy matcher's job here would be to put things you did not
 * ask for in front of the thing you did.
 */
export function spawnMatches(row: SpawnRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${row.label} ${row.id} ${row.hint ?? ''}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}
