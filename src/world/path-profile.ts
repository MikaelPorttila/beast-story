/**
 * PATH PROFILES — what KIND of path this is, as one derived bundle.
 *
 * Issue #142. Before this file every number that describes a corridor was a
 * module constant, and there were about fifteen of them spread over five files:
 * `DECK_HALF` and `DECK_EDGE` in roads.ts, `ROAD_CORE` / `ROAD_BLEND` /
 * `SHOULDER_IN` / `CARVE_INSET` / `APRON_R` beside them, `XS` / `SHOULDER_AT` /
 * `RIM_GUARD` in town-parts.ts, `POST_ROAD_CLEAR` / `LAMP_ROAD_CLEAR` /
 * `FENCE_ROAD_CLEAR` in towns.ts, `ROAD_SOFT_CLEAR` in props.ts,
 * `NPC_ROAD_CLEAR` in npc.ts. One width, folded fifteen ways.
 *
 * WHY THEY ARE COMPUTED TOGETHER AND NOT AUTHORED SEPARATELY.
 *
 * roads.ts says it outright about four of them: the carve target, `shoulderIn`,
 * the cross-section `xs` and the ribbon's `rimGuard` all describe THE SAME BAND
 * — the run between the flat carriageway and the levelled shoulder — and every
 * sample of issue #15 ("ground clipping through on to the road") lived in that
 * band while two of the four disagreed about where it ended. Exposing them as
 * four independent knobs would be handing an author four ways to reopen it.
 *
 * So this is not a settings bag. `pathProfile()` takes the two things that are
 * genuinely a choice — how wide the path is and whether it carves — and derives
 * the band from them, in one place, the way the road's own constants were
 * derived from `DECK_HALF` by hand.
 *
 * WHAT SCALES WITH WIDTH AND WHAT DOES NOT. Three of these numbers are about
 * the TERRAIN CELL rather than about the path, and they stay fixed as the path
 * narrows: `rimGuard` and `carveInset` are both half a cell diagonal (0.707,
 * rounded up), and `sink` is set by the ribbon's own float over the column it
 * hides. A profile that scaled them would be scaling the wrong thing — the
 * ground is a 1-unit grid whatever runs over it.
 *
 * Verified against the numbers this replaces: `pathProfile({ halfWidth: 2.8 })`
 * reproduces the road exactly — deckHalf 2.8, verge 2.2, deckEdge 5.0,
 * shoulderIn 0.8, carveCore 6.5, carveBlend 13, apronR 11, avoidR 18 — so the
 * change moves no pixel. `tools/test-road.mjs` is the proof.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const s2l = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
/** sRGB hex -> the linear triple the terrain material's vertex colours are in. */
export const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255),
];

/**
 * The four colours a cross-section is painted from.
 *
 * `sectionColour` (town-parts.ts) already picked between these four per vertex;
 * carrying them on the profile is most of "customize road type" and "path type
 * parameter" from issue #142 for no runtime cost at all — the ribbon is vertex
 * colours on the terrain material either way, which is why textures are NOT
 * part of this (a second material is a draw call and a second shadow pass).
 */
export interface PathPalette {
  /** Down the middle, where the wheels go. */
  rut: [number, number, number];
  /** Between the rut and the verge. */
  earth: [number, number, number];
  /** The verge itself, and the junction apron's rim. */
  gravel: [number, number, number];
  /** A bridge deck, which is planks and not ground. */
  plank: [number, number, number];
}

/** The cart road: packed earth ruts between gravel verges. */
export const CART_PALETTE: PathPalette = {
  rut: lin(0x6b5843),
  earth: lin(0x8a7a60),
  gravel: lin(0x9a8f79),
  plank: lin(0x7d6142),
};

/**
 * A walked path: bare earth in the middle, grass creeping in at the sides.
 *
 * Darker and greener than the cart road all through, and with no gravel — a
 * footpath is not surfaced, it is worn. The `gravel` slot is the verge colour
 * whatever the path is made of, so here it is a dry, trodden green rather than
 * a lighter stone.
 */
export const FOOT_PALETTE: PathPalette = {
  rut: lin(0x5d4a35),
  earth: lin(0x6f5c42),
  gravel: lin(0x77714f),
  plank: lin(0x6b5334),
};

// ---------------------------------------------------------------------------

/** What the earthworks do under a path. See `PathProfile.carve`. */
export type PathCarve =
  /** Cut and fill: the corridor is levelled into the height field. */
  | 'full'
  /**
   * Nothing at all. The path follows the ground it is drawn on, which is what a
   * trodden trail does — and it makes the trail the CHEAP case rather than the
   * expensive one, since with no carve there is no band to keep in step.
   */
  | 'none';

/** Everything that makes one kind of path different from another. */
export interface PathProfile {
  /** `path:<name>` per the id rule — what an asset selects a profile by. */
  readonly id: string;
  /**
   * Half-width of the CARRIAGEWAY — the flat part, where the walking surface is
   * the deck exactly.
   */
  readonly deckHalf: number;
  /** Width of the verge ramp outside it, where the deck meets the shoulder. */
  readonly verge: number;
  /** Outer edge of the walking surface, and of the drawn ribbon. */
  readonly deckEdge: number;
  /**
   * How far INSIDE the rim the shoulder has reached its full height — one number
   * for the carve's ramp and the surface's ramp, because they are the same ramp
   * seen from either side. See roads.ts.
   *
   * Cell-scale, not width-scale, and capped at half the verge so a narrow path
   * still has a ramp to run over.
   */
  readonly shoulderIn: number;
  /** What the earthworks do here. */
  readonly carve: PathCarve;
  /** How far the earthworks are fully applied. */
  readonly carveCore: number;
  /** Where they have faded back into natural ground. */
  readonly carveBlend: number;
  /** How far the carved column is sunk under the surface drawn over it. */
  readonly sink: number;
  /** How far inside the terminal plane the earthworks stop. */
  readonly carveInset: number;
  /** How far around a rim vertex the ribbon looks for ground it must cover. */
  readonly rimGuard: number;
  /** Cross-section offsets from the centreline, ascending, rim to rim. */
  readonly xs: readonly number[];
  /** Radius of the apron drawn where arms of this profile meet. */
  readonly apronR: number;
  /** How far two paths of this profile must run apart to read as two paths. */
  readonly avoidR: number;
  /**
   * What roadside furniture this path carries (issue #142, §14).
   *
   * `road` is lamps, fingerposts and the roadside fence runs. `none` is a path
   * that has none of them, which is most paths — a lamp every 26 units down a
   * footpath through a wood would be a lit street with no houses on it.
   */
  readonly furniture: 'road' | 'none';
  /**
   * Whether this path may BRIDGE open water, or must go round it.
   *
   * Bridges are hardcoded to the cart road's geometry — stone piers, a plank
   * deck and a railing (`addBridgeFurniture`) — so a path that cannot carry
   * that has to tell the router, and the router pays a lake's price for every
   * wet step instead of a neck's. A ford (follow the bed, no lift, no
   * furniture) is the third answer and it is not built yet; §11h.
   */
  readonly bridges: boolean;
  /** The colours the section is painted from. */
  readonly palette: PathPalette;
}

/**
 * Widest radius the carve can reach on any profile. `RoadNetwork`'s spatial
 * index sizes its catchment to this, so it must bound every profile ever built
 * — the alternative is a per-network max, which is a fine idea and also a
 * bucket scan that grows the day somebody authors a wide path. See `REACH`.
 */
export const MAX_CARVE_BLEND = 13;

/** Half a terrain cell's diagonal, rounded up. See the header. */
const CELL_GUARD = 0.75;

/**
 * Derive a profile from the two things that are actually a choice.
 *
 * Every ratio below is the road's own number divided by the road's own
 * half-width, so `pathProfile({ halfWidth: 2.8 })` is the road that shipped.
 */
export function pathProfile(opts: {
  id: string;
  /** Half-width of the flat part. The road is 2.8; a footpath is ~0.9. */
  halfWidth: number;
  carve?: PathCarve;
  furniture?: 'road' | 'none';
  bridges?: boolean;
  palette?: PathPalette;
}): PathProfile {
  const deckHalf = opts.halfWidth;
  // 2.2 / 2.8 on the road: the verge is about four fifths of the carriageway,
  // which is what makes a corridor read as built earth rather than as a strip.
  const verge = deckHalf * (2.2 / 2.8);
  const deckEdge = deckHalf + verge;
  // 0.8 was the road's, and it is a cell-scale number — but it has to fit
  // INSIDE the verge or `surfaceOf`'s ramp divides by a negative.
  const shoulderIn = Math.min(0.8, verge * 0.5);
  const carve = opts.carve ?? 'full';
  const shoulderAt = deckEdge - shoulderIn;
  const carveBlend = Math.min(MAX_CARVE_BLEND, deckEdge + 8);
  return {
    id: opts.id,
    deckHalf,
    verge,
    deckEdge,
    shoulderIn,
    carve,
    // Comfortably past the rim, so the ribbon's outer edge lands on ground that
    // is already levelled — see `ROAD_CORE`'s old comment in roads.ts.
    carveCore: deckEdge + 1.5,
    carveBlend,
    sink: 0.62,
    carveInset: CELL_GUARD,
    rimGuard: CELL_GUARD,
    // NINE offsets, at the router's own ring spacing. The two at `shoulderAt`
    // are the corner the cross-section actually has; see `XS` in town-parts.ts
    // for the 178 samples of issue #15 that were the ribbon passing under it.
    xs: [
      -deckEdge, -shoulderAt, -deckHalf, -deckHalf * 0.45,
      0,
      deckHalf * 0.45, deckHalf, shoulderAt, deckEdge,
    ],
    apronR: deckEdge + 6,
    // 18 on the road, which is 2 * deckEdge + 8: two full corridors plus eight
    // units of ground down the middle for the verges, a lamp and the grass to
    // come back in. See `AVOID_R` in roads.ts for the measurement.
    avoidR: deckEdge * 2 + 8,
    furniture: opts.furniture ?? 'road',
    bridges: opts.bridges ?? true,
    palette: opts.palette ?? CART_PALETTE,
  };
}

/**
 * THE CART ROAD — the profile every number above was reverse-engineered from.
 */
export const ROAD_PROFILE = pathProfile({ id: 'path:road', halfWidth: 2.8 });

/**
 * THE FOOTPATH — half the road's width, and the proof the parameterisation is
 * real rather than a rename.
 *
 * Every derived number differs: rim 2.5 against 5.0, verge 1.1, shoulder ramp
 * 0.55, earthworks out to 4.0 and gone by 10.5, apron 8.5, and two paths of it
 * only have to run 13 apart to read as two. It carries no lamps and no
 * fingerposts, and it will not bridge — see `bridges`.
 *
 * 1.4 is the narrowest width the CARVE mechanism can still hold up. The verge
 * is 1.1, the shoulder ramp `min(0.8, verge / 2)` is 0.55, and the ramp the
 * carve and the surface share is the difference — 0.55 of run to climb up to
 * half a unit. Narrower and that ramp is steeper than the step it exists to
 * hide, which is where a no-carve profile has to take over (§11f); this one
 * stays inside the machine that is already guarded.
 */
export const FOOTPATH_PROFILE = pathProfile({
  id: 'path:footpath',
  halfWidth: 1.4,
  furniture: 'none',
  bridges: false,
  palette: FOOT_PALETTE,
});
