/** The debug spawner's model. main.ts supplies the branches and the spawn function. */
import type { StringKey } from '../i18n';

export type SpawnTarget = 'bag' | 'party' | 'world';

export interface SpawnRow {
  /** Stable id, passed straight back to `spawn`. */
  id: string;
  /** Already localised by the host. */
  label: string;
  /** Extra text the search matches but the row does not show. */
  hint?: string;
  /** Effect already happened — a bonded beast. Shown greyed. */
  had?: boolean;
}

export interface SpawnBranch {
  id: string;
  labelKey: StringKey;
  noteKey: StringKey;
  target: SpawnTarget;
  rows: readonly SpawnRow[];
}

export interface SpawnCatalogue {
  /** Re-derived on each draw: content loads and bonds change what exists. */
  branches(): readonly SpawnBranch[];
  /** Make one row real. Returns a line to show, or an error line. */
  spawn(branchId: string, rowId: string): string;
}

/** Case-folded AND-substring over label, id and hint. Not fuzzy, by design. */
export function spawnMatches(row: SpawnRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${row.label} ${row.id} ${row.hint ?? ''}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}
