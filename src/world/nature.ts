/**
 * NATURE PARAMETERS — how much of each living thing the world grows, as named
 * numbers instead of literals buried in a placement loop.
 *
 * THE BASELINE IS THE GAME, AND AN AREA ADJUSTS IT. That is issue #50's whole
 * shape and it is the reason every parameter here is a dimensionless MULTIPLIER
 * whose default is exactly 1: the baseline is the tuned world `props.ts` already
 * builds, with every measured threshold and every comment that says what it was
 * captured at left where it is. An area then says "half the trees" rather than
 * "trees at 0.40 acceptance", so a per-area value cannot silently fork from the
 * baseline it was derived from — move the baseline and every area moves with it.
 * At the shipped values (all 1, no area overrides) the placement is bit-for-bit
 * what it was before this file existed, which is the property that makes the
 * knob safe to add to code that has been tuned against captures for months.
 *
 * WHY MULTIPLIERS RATHER THAN A DENSITY TABLE. The obvious design is a table of
 * real densities — trees per chunk, tussocks per clump — and it was rejected
 * because those numbers are not free-standing: `props.ts` spends its acceptance
 * rates against a 16-candidate lattice whose spacing was chosen with the crown
 * radius, and its clump counts against a ~3 ms build budget measured on a real
 * frame. A table would have to restate all of that, and would then be the second
 * place a density is written down — which is exactly how a value goes stale.
 *
 * AN "AREA" IS A BIOME TODAY. `NatureAreaId` is `BiomeId` deliberately: the
 * world's only existing notion of "somewhere with its own character" is what
 * `columnInfo` already answers per column, and `props.ts` dispatches its whole
 * scatter off it. A future named region (a blighted valley, a town's outskirts)
 * becomes a second area kind by widening this type and the one `for()` lookup —
 * nothing else in the file knows what an area is.
 *
 * WHY NOT `flags.ts` AND WHY NOT `gfx.ts`. A URL flag is read once and cannot
 * change without a reload, which is the wrong shape for tuning — you want to
 * type a number, look at the meadow, and type another. A `gfx` toggle is a
 * PLAYER's setting, persisted, and about what a frame costs; these change what
 * the world IS, so they are deliberately NOT stored: a session ends and the
 * world is the designed one again. What they share with both is the registry
 * shape — one entry in `NATURE_PARAMS` and three surfaces (the URL, `/nature`,
 * `__dbgNature`) pick it up with no further wiring.
 *
 * COST. `for(area)` is called once per placement candidate — a few hundred times
 * a chunk build — so it returns a CACHED frozen record per area and allocates
 * nothing until something actually changes a value.
 */
import type { BiomeId } from './terrain';

/**
 * The tunable quantities. Each one names a group of placements in `props.ts`
 * that a designer would think of as one thing, which is a coarser grouping than
 * the file's own passes: "grass" is the meadow clump pass's carpet, its
 * tussocks and its billboard blades together, because nobody wants three
 * numbers to make a field thicker.
 */
export type NatureParamId =
  'trees' | 'grass' | 'flowers' | 'bushes' | 'rocks' | 'reeds';

/** Where a value applies. Areas are biomes today — see the note at the top. */
export type NatureAreaId = BiomeId;

export interface NatureParamDef {
  id: NatureParamId;
  /** One line, printed by `/nature` with no arguments. */
  help: string;
  /**
   * The baseline. 1 means "the world as tuned", and every parameter here is 1
   * for that reason — a baseline that is not 1 would be a density decision
   * taken twice, here and at the placement site.
   */
  def: number;
  /**
   * Ceiling on the resolved value. Not a taste: `props.ts` spends a ~3 ms
   * per-frame chunk-build budget and the meadow pass is already most of it, so
   * a mistyped `/nature grass 40` must not lock the streamer up. 4 is roughly
   * where a plains chunk stops fitting in a frame on the machine this was
   * measured on.
   */
  max: number;
}

export const NATURE_PARAMS: readonly NatureParamDef[] = [
  { id: 'trees', help: 'trees, palms and cacti — the tree pass acceptance rate', def: 1, max: 4 },
  { id: 'grass', help: 'meadow clumps and everything in one: sprigs, tussocks, blades', def: 1, max: 4 },
  { id: 'flowers', help: 'the lone blossom in a clump and the per-region bloom drifts', def: 1, max: 4 },
  { id: 'bushes', help: 'hedges and the bush that anchors a meadow clump', def: 1, max: 4 },
  { id: 'rocks', help: 'boulder clusters, outcrops and the lone mid-ground rock', def: 1, max: 4 },
  { id: 'reeds', help: 'reed stands at the waterline', def: 1, max: 4 },
];

/** Every parameter at its baseline — the resolved record for an untouched area. */
const DEFAULTS = Object.freeze(
  Object.fromEntries(NATURE_PARAMS.map((p) => [p.id, p.def])),
) as Readonly<Record<NatureParamId, number>>;

const byId = new Map(NATURE_PARAMS.map((p) => [p.id, p]));

/** Clamp to the parameter's own range; a non-number lands on the baseline. */
function clamp(def: NatureParamDef, v: number): number {
  if (!Number.isFinite(v)) return def.def;
  return Math.min(def.max, Math.max(0, v));
}

export class NatureField {
  /** Baseline overrides. Absent means "the shipped default", as in gfx.ts. */
  private readonly bases = new Map<NatureParamId, number>();

  /** Per-area multipliers ON TOP of the baseline, keyed `area.param`. */
  private readonly areas = new Map<string, number>();

  /** Resolved records, one per area, rebuilt lazily after any change. */
  private readonly cache = new Map<NatureAreaId, Readonly<Record<NatureParamId, number>>>();

  private readonly listeners = new Set<() => void>();

  /** The baseline value of one parameter. */
  base(id: NatureParamId): number {
    return this.bases.get(id) ?? byId.get(id)!.def;
  }

  /** One area's multiplier, 1 where the area has nothing to say. */
  areaFactor(area: NatureAreaId, id: NatureParamId): number {
    return this.areas.get(`${area}.${id}`) ?? 1;
  }

  /**
   * Everything resolved for one area — `baseline * area`, clamped.
   *
   * The returned record is shared and frozen, so a caller in a placement loop
   * can hold it for the whole chunk without allocating. It is replaced rather
   * than mutated when a value changes, so a held reference stays consistent
   * with the chunk it was resolved for.
   */
  for(area: NatureAreaId): Readonly<Record<NatureParamId, number>> {
    const hit = this.cache.get(area);
    if (hit) return hit;
    const out = {} as Record<NatureParamId, number>;
    for (const p of NATURE_PARAMS) {
      out[p.id] = clamp(p, this.base(p.id) * this.areaFactor(area, p.id));
    }
    const frozen = Object.freeze(out);
    this.cache.set(area, frozen);
    return frozen;
  }

  /** Set the baseline. Returns what was actually stored after clamping. */
  setBase(id: NatureParamId, value: number): number {
    const def = byId.get(id);
    if (!def) return 0;
    const v = clamp(def, value);
    // The DEFAULT is the ABSENCE of an entry, the same rule gfx.ts and prefs.ts
    // state: it keeps "never touched" distinct from "set to the default", which
    // is what `isDefault` below reports to a capture.
    if (v === def.def) this.bases.delete(id);
    else this.bases.set(id, v);
    this.changed();
    return v;
  }

  /** Set one area's multiplier. `null` removes it, restoring the baseline. */
  setArea(area: NatureAreaId, id: NatureParamId, value: number | null): number {
    const def = byId.get(id);
    if (!def) return 0;
    const key = `${area}.${id}`;
    if (value === null) {
      this.areas.delete(key);
      this.changed();
      return 1;
    }
    // Clamped against the parameter's own ceiling, so an area cannot take the
    // resolved value anywhere the baseline could not go on its own.
    const v = clamp(def, value);
    if (v === 1) this.areas.delete(key);
    else this.areas.set(key, v);
    this.changed();
    return v;
  }

  /** Back to the designed world, areas included. */
  reset(): void {
    this.bases.clear();
    this.areas.clear();
    this.changed();
  }

  /**
   * True while nothing has been touched — what a capture asks before claiming
   * it photographed the game rather than a tuning session.
   */
  isDefault(): boolean {
    return this.bases.size === 0 && this.areas.size === 0;
  }

  /** For `__dbgNature`, `/nature` with no arguments, and the probe. */
  snapshot(): {
    baseline: Record<string, number>;
    areas: Record<string, number>;
    isDefault: boolean;
    } {
    const baseline: Record<string, number> = {};
    for (const p of NATURE_PARAMS) baseline[p.id] = this.base(p.id);
    return {
      baseline,
      areas: Object.fromEntries(this.areas),
      isDefault: this.isDefault(),
    };
  }

  /**
   * Called after any change, so the host can rebuild what is already streamed.
   *
   * A listener rather than a direct call into the world: this file sits below
   * `world/index.ts` in the dependency graph (`props.ts` imports it), and the
   * one thing that has to happen on a change — re-streaming the loaded chunks —
   * is the world's business, not a parameter table's. main.ts wires it, exactly
   * as it wires `GfxSinks`.
   */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.cache.clear();
    for (const fn of this.listeners) fn();
  }
}

export const nature = new NatureField();

/**
 * `?nature=trees:0.5,forest.grass:0,plains.trees:2`
 *
 * A term with a dot sets an AREA multiplier, one without sets the baseline —
 * the same two-level shape the runtime API has, so what you type at `/nature`
 * and what you put in a URL are the same statement. Applied at module load, so
 * the first chunk the streamer builds already has it.
 *
 * Silently ignores a term it cannot parse rather than throwing: this is a
 * diagnostic surface reached from an address bar, and half a typed override
 * applying is a better failure than a black page.
 */
function readUrl(): void {
  if (typeof location === 'undefined') return;
  const raw = new URLSearchParams(location.search).get('nature');
  if (!raw) return;
  for (const term of raw.split(',')) {
    const [lhs, rhs] = term.split(':');
    if (rhs === undefined) continue;
    const v = Number(rhs);
    if (!Number.isFinite(v)) continue;
    const dot = lhs.indexOf('.');
    if (dot < 0) {
      if (byId.has(lhs.trim() as NatureParamId)) nature.setBase(lhs.trim() as NatureParamId, v);
      continue;
    }
    const area = lhs.slice(0, dot).trim() as NatureAreaId;
    const id = lhs.slice(dot + 1).trim() as NatureParamId;
    if (byId.has(id)) nature.setArea(area, id, v);
  }
}
readUrl();

/**
 * Scale a placement COUNT by a density factor.
 *
 * Rounded rather than floored, so `1` is untouched at every factor of 1 and a
 * factor of 0.5 halves a count instead of quietly emptying the small ones. The
 * caller draws its `rng()` first and scales afterwards — the per-chunk stream
 * places every tree in the world, so a factor must never change how many draws
 * are made before the next placement (see `trodden` in props.ts for the same
 * rule stated from the other side).
 */
export const natureCount = (n: number, f: number): number => Math.round(n * f);

/** Everything at baseline, for a caller with no area in hand. */
export const NATURE_BASELINE = DEFAULTS;
