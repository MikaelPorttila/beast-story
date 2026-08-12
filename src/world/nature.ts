/**
 * Nature density knobs (issue #50). Every parameter is a MULTIPLIER defaulting
 * to 1, so the tuned baseline stays in `props.ts` and shipped values are
 * bit-for-bit what they were. Never persisted — not a player setting.
 */
import type { BiomeId } from "./terrain";

/** Coarser than props.ts's own passes: "grass" covers carpet, tussocks and blades. */
export type NatureParamId = "trees" | "grass" | "flowers" | "bushes" | "rocks" | "reeds";

/** An area is a biome today; widen this and the `for()` lookup to add another kind. */
export type NatureAreaId = BiomeId;

export interface NatureParamDef {
  id: NatureParamId;
  help: string;
  def: number;
  /** Ceiling on the resolved value: past ~4 a plains chunk stops fitting in a frame. */
  max: number;
}

export const NATURE_PARAMS: readonly NatureParamDef[] = [
  { id: "trees", help: "trees, palms and cacti — the tree pass acceptance rate", def: 1, max: 4 },
  {
    id: "grass",
    help: "meadow clumps and everything in one: sprigs, tussocks, blades",
    def: 1,
    max: 4,
  },
  {
    id: "flowers",
    help: "the lone blossom in a clump and the per-region bloom drifts",
    def: 1,
    max: 4,
  },
  { id: "bushes", help: "hedges and the bush that anchors a meadow clump", def: 1, max: 4 },
  { id: "rocks", help: "boulder clusters, outcrops and the lone mid-ground rock", def: 1, max: 4 },
  { id: "reeds", help: "reed stands at the waterline", def: 1, max: 4 },
];

const DEFAULTS = Object.freeze(
  Object.fromEntries(NATURE_PARAMS.map((p) => [p.id, p.def])),
) as Readonly<Record<NatureParamId, number>>;

const byId = new Map(NATURE_PARAMS.map((p) => [p.id, p]));

function clamp(def: NatureParamDef, v: number): number {
  if (!Number.isFinite(v)) {
    return def.def;
  }
  return Math.min(def.max, Math.max(0, v));
}

export class NatureField {
  /** Absent means "the shipped default", as in gfx.ts. */
  private readonly bases = new Map<NatureParamId, number>();

  /** Keyed `area.param`, multiplying the baseline. */
  private readonly areas = new Map<string, number>();

  private readonly cache = new Map<NatureAreaId, Readonly<Record<NatureParamId, number>>>();

  private readonly listeners = new Set<() => void>();

  base(id: NatureParamId): number {
    return this.bases.get(id) ?? byId.get(id)!.def;
  }

  areaFactor(area: NatureAreaId, id: NatureParamId): number {
    return this.areas.get(`${area}.${id}`) ?? 1;
  }

  /**
   * `baseline * area`, clamped. Cached and frozen so a placement loop allocates
   * nothing, and replaced rather than mutated so a held reference stays stable.
   */
  for(area: NatureAreaId): Readonly<Record<NatureParamId, number>> {
    const hit = this.cache.get(area);
    if (hit) {
      return hit;
    }
    const out = {} as Record<NatureParamId, number>;
    for (const p of NATURE_PARAMS) {
      out[p.id] = clamp(p, this.base(p.id) * this.areaFactor(area, p.id));
    }
    const frozen = Object.freeze(out);
    this.cache.set(area, frozen);
    return frozen;
  }

  setBase(id: NatureParamId, value: number): number {
    const def = byId.get(id);
    if (!def) {
      return 0;
    }
    const v = clamp(def, value);
    // Default = absence of an entry, so `isDefault` can tell "never touched" apart.
    if (v === def.def) {
      this.bases.delete(id);
    } else {
      this.bases.set(id, v);
    }
    this.changed();
    return v;
  }

  /** `null` restores the baseline. */
  setArea(area: NatureAreaId, id: NatureParamId, value: number | null): number {
    const def = byId.get(id);
    if (!def) {
      return 0;
    }
    const key = `${area}.${id}`;
    if (value === null) {
      this.areas.delete(key);
      this.changed();
      return 1;
    }
    // Same ceiling as the baseline: an area cannot exceed what a base could.
    const v = clamp(def, value);
    if (v === 1) {
      this.areas.delete(key);
    } else {
      this.areas.set(key, v);
    }
    this.changed();
    return v;
  }

  reset(): void {
    this.bases.clear();
    this.areas.clear();
    this.changed();
  }

  isDefault(): boolean {
    return this.bases.size === 0 && this.areas.size === 0;
  }

  snapshot(): {
    baseline: Record<string, number>;
    areas: Record<string, number>;
    isDefault: boolean;
  } {
    const baseline: Record<string, number> = {};
    for (const p of NATURE_PARAMS) {
      baseline[p.id] = this.base(p.id);
    }
    return {
      baseline,
      areas: Object.fromEntries(this.areas),
      isDefault: this.isDefault(),
    };
  }

  /** A listener because this file sits below `world/index.ts`; main.ts wires re-streaming. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.cache.clear();
    for (const fn of this.listeners) {
      fn();
    }
  }
}

export const nature = new NatureField();

/**
 * `?nature=trees:0.5,plains.trees:2` — a dotted term sets an area multiplier.
 * Runs at module load so the first chunk has it; bad terms are ignored, not thrown.
 */
function readUrl(): void {
  if (typeof location === "undefined") {
    return;
  }
  const raw = new URLSearchParams(location.search).get("nature");
  if (!raw) {
    return;
  }
  for (const term of raw.split(",")) {
    const [lhs, rhs] = term.split(":");
    if (rhs === undefined) {
      continue;
    }
    const v = Number(rhs);
    if (!Number.isFinite(v)) {
      continue;
    }
    const dot = lhs.indexOf(".");
    if (dot < 0) {
      if (byId.has(lhs.trim() as NatureParamId)) {
        nature.setBase(lhs.trim() as NatureParamId, v);
      }
      continue;
    }
    const area = lhs.slice(0, dot).trim() as NatureAreaId;
    const id = lhs.slice(dot + 1).trim() as NatureParamId;
    if (byId.has(id)) {
      nature.setArea(area, id, v);
    }
  }
}
readUrl();

/**
 * Scale a placement COUNT; rounded so 0.5 halves rather than empties. Callers
 * draw `rng()` FIRST — a factor must not change how many draws precede a placement.
 */
export const natureCount = (n: number, f: number): number => Math.round(n * f);

export const NATURE_BASELINE = DEFAULTS;
