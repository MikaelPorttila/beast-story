/**
 * PATH PROFILES — what KIND of path this is, as one derived bundle (issue #142).
 *
 * The carve target, `shoulderIn`, `xs` and `rimGuard` all describe ONE band, so
 * they are derived from halfWidth here rather than authored apart — issue #15
 * lived in that band with the numbers disagreeing about where it ended.
 * `rimGuard`, `carveInset` and `sink` are cell-scale and do NOT scale with
 * width: the ground is a 1-unit grid whatever runs over it.
 */

const s2l = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** sRGB hex -> the linear triple the terrain material's vertex colours are in. */
export const lin = (hex: number): [number, number, number] => [
  s2l(((hex >> 16) & 255) / 255),
  s2l(((hex >> 8) & 255) / 255),
  s2l((hex & 255) / 255),
];

/**
 * The four colours a cross-section is painted from. Vertex colours on the
 * terrain material — no textures, which would cost a draw call and shadow pass.
 */
export interface PathPalette {
  rut: [number, number, number];
  earth: [number, number, number];
  /** The verge, and the junction apron's rim. */
  gravel: [number, number, number];
  plank: [number, number, number];
}

export const TRAIL_PALETTE: PathPalette = {
  rut: lin(0x4a3a28),
  earth: lin(0x584631),
  gravel: lin(0x5f5540),
  plank: lin(0x5a462c),
};

export const CART_PALETTE: PathPalette = {
  rut: lin(0x6b5843),
  earth: lin(0x8a7a60),
  gravel: lin(0x9a8f79),
  plank: lin(0x7d6142),
};

export const FOOT_PALETTE: PathPalette = {
  rut: lin(0x5d4a35),
  earth: lin(0x6f5c42),
  gravel: lin(0x77714f),
  plank: lin(0x6b5334),
};

/**
 * What a path is FOR. The network indexes each path per role it claims, and
 * `nearest` takes the role its caller means — which is what keeps a wide camp
 * track (which carves nothing) from out-ranking the cart road in the height field.
 */
export interface PathRoles {
  /** Carves the height field and owns the walking surface: `carveAt`, `surfaceAt`. */
  readonly surface: boolean;
  /** Refuses BUILT things: `builtEdgeDistanceTo`, `spanBuiltEdgeDistanceTo`. */
  readonly refusesBuilt: boolean;
  /** Refuses GROWN things. `edgeDistanceTo` sees these — which is every path. */
  readonly refusesFoliage: boolean;
  /** Emits a ribbon. A painted path is a colour field and no geometry. */
  readonly draw: boolean;
  /** Paints packed dirt via `Terrain.trampleAt`. Strength is per path (`Road.wear`). */
  readonly wears: boolean;
}

export type PathCarve =
  /** Cut and fill: the corridor is levelled into the height field. */
  | "full"
  /** Nothing — the path follows the ground it is drawn on. */
  | "none";

export interface PathProfile {
  /** `path:<name>` per the id rule. */
  readonly id: string;
  /** Half-width of the flat carriageway, where the walking surface IS the deck. */
  readonly deckHalf: number;
  readonly verge: number;
  /** Outer edge of the walking surface, and of the drawn ribbon. */
  readonly deckEdge: number;
  /**
   * How far inside the rim the shoulder is at full height — one number for both
   * the carve's and the surface's ramp. Cell-scale, capped at half the verge.
   */
  readonly shoulderIn: number;
  readonly carve: PathCarve;
  readonly carveCore: number;
  readonly carveBlend: number;
  /** How far the carved column is sunk under the surface drawn over it. */
  readonly sink: number;
  /** How far inside the terminal plane the earthworks stop. */
  readonly carveInset: number;
  /** How far around a rim vertex the ribbon looks for ground it must cover. */
  readonly rimGuard: number;
  /** Cross-section offsets from the centreline, ascending, rim to rim. */
  readonly xs: readonly number[];
  readonly apronR: number;
  /** How far two paths of this profile must run apart to read as two paths. */
  readonly avoidR: number;
  /** `road` is lamps, fingerposts and fence runs (issue #142). */
  readonly furniture: "road" | "none";
  /**
   * May BRIDGE open water, or must route round it. Bridges are hardcoded to the
   * cart road's geometry (`addBridgeFurniture`); fords are not built yet.
   */
  readonly bridges: boolean;
  readonly roles: PathRoles;
  /** Loose stone and stick thrown to the sides, 0..1. `RoadNetwork.litterAt` places it. */
  readonly litter: number;
  readonly palette: PathPalette;
}

const BUILT_ROLES: PathRoles = {
  surface: true,
  refusesBuilt: true,
  refusesFoliage: true,
  draw: true,
  wears: false,
};
/** A beaten track must NOT refuse what is built beside it: it was derived from it. */
const WORN_ROLES: PathRoles = {
  surface: false,
  refusesBuilt: false,
  refusesFoliage: true,
  draw: false,
  wears: true,
};
/** A paved street: a track's roles minus wearing — flagstones are laid, not worn. */
const PAVED_ROLES: PathRoles = {
  surface: false,
  refusesBuilt: false,
  refusesFoliage: true,
  draw: false,
  wears: false,
};

/** Bounds every profile: `RoadNetwork`'s spatial index sizes its catchment to it. */
export const MAX_CARVE_BLEND = 13;

/** Half a terrain cell's diagonal, rounded up. */
const CELL_GUARD = 0.75;

/** Every ratio below is the road's own number over its half-width (2.8). */
export function pathProfile(opts: {
  id: string;
  halfWidth: number;
  verge?: number;
  carve?: PathCarve;
  furniture?: "road" | "none";
  bridges?: boolean;
  roles?: PathRoles;
  litter?: number;
  palette?: PathPalette;
}): PathProfile {
  const deckHalf = opts.halfWidth;
  // 2.2 / 2.8 on the road: verge is four fifths of the carriageway.
  const verge = opts.verge ?? deckHalf * (2.2 / 2.8);
  const deckEdge = deckHalf + verge;
  // 0.8 is the road's, cell-scale — must fit INSIDE the verge or `surfaceOf`'s
  // ramp divides by a negative.
  const shoulderIn = Math.min(0.8, verge * 0.5);
  const carve = opts.carve ?? "full";
  const shoulderAt = deckEdge - shoulderIn;
  const carveBlend = Math.min(MAX_CARVE_BLEND, deckEdge + 8);
  return {
    id: opts.id,
    deckHalf,
    verge,
    deckEdge,
    shoulderIn,
    carve,
    // Past the rim, so the ribbon's outer edge lands on levelled ground.
    carveCore: deckEdge + 1.5,
    carveBlend,
    sink: 0.62,
    carveInset: CELL_GUARD,
    rimGuard: CELL_GUARD,
    // Nine offsets at the router's ring spacing; the pair at `shoulderAt` is the
    // corner the section has — issue #15 was the ribbon passing under it.
    xs: [
      -deckEdge,
      -shoulderAt,
      -deckHalf,
      -deckHalf * 0.45,
      0,
      deckHalf * 0.45,
      deckHalf,
      shoulderAt,
      deckEdge,
    ],
    apronR: deckEdge + 6,
    // 18 on the road: two corridors plus 8 units for verges, a lamp and grass.
    avoidR: deckEdge * 2 + 8,
    furniture: opts.furniture ?? "road",
    bridges: opts.bridges ?? true,
    roles: opts.roles ?? BUILT_ROLES,
    litter: opts.litter ?? 0,
    palette: opts.palette ?? CART_PALETTE,
  };
}

/** The cart road — the profile every number above was derived from. */
export const ROAD_PROFILE = pathProfile({
  id: "path:road",
  halfWidth: 2.8,
  litter: 0.35,
});

/**
 * 1.4 is the narrowest width the carve mechanism holds up: below it the shared
 * carve/surface ramp is steeper than the step it exists to hide.
 */
export const FOOTPATH_PROFILE = pathProfile({
  id: "path:footpath",
  halfWidth: 1.4,
  furniture: "none",
  bridges: false,
  litter: 0.6,
  palette: FOOT_PALETTE,
});

/**
 * The painting test is hard-edged, so `deckEdge` must land exactly on the
 * builder's half-width: the kerb takes a third of a voxel cell (island `CELL` 1.2).
 */
export function flagstoneProfile(halfWidth: number): PathProfile {
  const kerb = 0.4;
  return pathProfile({
    id: "path:flagstone",
    halfWidth: halfWidth - kerb,
    verge: kerb,
    carve: "none",
    furniture: "none",
    bridges: false,
    roles: PAVED_ROLES,
  });
}

export const TRAIL_PROFILE = pathProfile({
  id: "path:trail",
  halfWidth: 1.0,
  // It carves: ground is 1-unit cubes against MAX_STEP_UP 0.5, so a no-carve
  // trail is a staircase. Stairs are the real answer (issue #142 §11); not built.
  furniture: "none",
  bridges: false,
  litter: 0.75,
  palette: TRAIL_PALETTE,
});

/**
 * A waystone's spur: a trail with NO LITTER.
 *
 * The trail profile scatters pebbles along its verge, which is right for a
 * footpath through open country and wrong for eight units of approach: one
 * pebble in eight units lands on the carriageway and `test-road` is right to
 * call it furniture standing in the road (issue #15). Everything else is the
 * trail's — it draws, it carves, and it is a metre wide.
 */
export const SPUR_PROFILE = pathProfile({
  id: "path:spur",
  // The 1.1 step this width was once raised to 1.5 over was never the carve:
  // it was `profileRoad`'s end anchor overrunning a short polyline, fixed at
  // the mechanism (issue #213). A spur is a trail's metre again.
  halfWidth: 1.0,
  furniture: "none",
  bridges: false,
  litter: 0,
  palette: TRAIL_PALETTE,
});

/** A settlement's beaten track: paints and keeps foliage off, nothing else. */
export function trackProfile(halfWidth: number): PathProfile {
  // 0.45 / 0.55 is `Terrain.trampleAt`'s soft edge: full over the middle 45%.
  return pathProfile({
    id: "path:track",
    halfWidth: halfWidth * 0.45,
    verge: halfWidth * 0.55,
    carve: "none",
    furniture: "none",
    bridges: false,
    roles: WORN_ROLES,
  });
}
