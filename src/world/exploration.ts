/**
 * Where the character has BEEN, per zone, as a coarse cell grid — what the
 * map's fog of war lifts. Session state under issue #171's rule: reset in
 * exitToTitle, written by collectSave, restored by applySave.
 */

/** World units per cell. Coarse on purpose: the record is a memory of a walk, not a heightfield. */
export const EXPLORE_CELL = 16;
/** Radius around the hero that counts as seen — the near ground he can read, well short of the horizon. */
export const EXPLORE_RADIUS = 110;

/** One packed int per cell so a save is a flat number array; cells within ±32767 of the origin. */
export const cellKey = (cx: number, cz: number): number =>
  (((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff)) >>> 0;
export const cellOf = (key: number): [number, number] => [
  (key >>> 16) - 0x8000,
  (key & 0xffff) - 0x8000,
];

const R_CELLS = Math.ceil(EXPLORE_RADIUS / EXPLORE_CELL);

export class Exploration {
  private readonly zones = new Map<string, Set<number>>();
  private lastZone = "";
  private lastCx = NaN;
  private lastCz = NaN;

  /** The hero is here; reveal the disc around him. Cheap when he has not left his cell. */
  visit(zone: string, x: number, z: number): void {
    const cx = Math.floor(x / EXPLORE_CELL);
    const cz = Math.floor(z / EXPLORE_CELL);
    if (zone === this.lastZone && cx === this.lastCx && cz === this.lastCz) {
      return;
    }
    this.lastZone = zone;
    this.lastCx = cx;
    this.lastCz = cz;
    let cells = this.zones.get(zone);
    if (!cells) {
      cells = new Set();
      this.zones.set(zone, cells);
    }
    const r2 = (EXPLORE_RADIUS / EXPLORE_CELL) ** 2;
    for (let j = -R_CELLS; j <= R_CELLS; j++) {
      for (let i = -R_CELLS; i <= R_CELLS; i++) {
        if (i * i + j * j <= r2) {
          cells.add(cellKey(cx + i, cz + j));
        }
      }
    }
  }

  revealed(zone: string, x: number, z: number): boolean {
    return (
      this.zones
        .get(zone)
        ?.has(cellKey(Math.floor(x / EXPLORE_CELL), Math.floor(z / EXPLORE_CELL))) ?? false
    );
  }

  /** Insertion-ordered, so a painter can pick up where it left off by count. */
  cells(zone: string): ReadonlySet<number> {
    return this.zones.get(zone) ?? EMPTY;
  }

  reset(): void {
    this.zones.clear();
    this.lastZone = "";
    this.lastCx = NaN;
    this.lastCz = NaN;
  }

  toJSON(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [zone, cells] of this.zones) {
      if (cells.size > 0) {
        out[zone] = [...cells];
      }
    }
    return out;
  }

  /** A RESTORE, not a merge; a zone this build no longer has is dropped, the rest loads. */
  fromJSON(raw: Record<string, number[]> | undefined, knownZones: readonly string[]): void {
    this.reset();
    for (const zone of Object.keys(raw ?? {})) {
      if (!knownZones.includes(zone)) {
        continue;
      }
      this.zones.set(zone, new Set(raw![zone]));
    }
  }
}

const EMPTY: ReadonlySet<number> = new Set();
