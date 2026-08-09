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

/**
 * WHAT A PATH IS FOR, and it is not one thing.
 *
 * Issue #142 wants every kind of path on one system, and the reason that was
 * not already true is this: the three mechanisms in the world answer DIFFERENT
 * questions. A cart road owns the walking surface, refuses everything and is
 * drawn. A settlement's beaten track owns nothing, is painted rather than
 * drawn, and — this is the part that makes a single flag impossible — MUST NOT
 * refuse the buildings around it, because it was derived from where they are.
 * The camp's tracks point at its own huts, tents and fire; a track that pushed
 * them away would be a track that erased its own reason for existing.
 *
 * So a profile declares its ROLES and the network indexes each path for the
 * ones it claims. `nearest` takes the role its caller means, which is also what
 * keeps a track out of the height field: a camp thoroughfare is 8.8 units wide
 * and would out-rank the cart road it runs along, and since it carves nothing
 * the walking surface on the carriageway would come back as natural ground.
 */
export interface PathRoles {
  /**
   * Carves the height field and owns the walking surface inside its rim.
   * `carveAt` and `surfaceAt` see only these.
   */
  readonly surface: boolean;
  /**
   * Refuses BUILT things — huts, tents, lamps, fingerposts, fences, people.
   * `builtEdgeDistanceTo` and `spanBuiltEdgeDistanceTo` see only these.
   */
  readonly refusesBuilt: boolean;
  /**
   * Refuses GROWN things — grass, trees, boulders, logs. `edgeDistanceTo` sees
   * these, which is every path: nothing in this world is worn bare by feet and
   * then has a hedge grow down the middle of it.
   */
  readonly refusesFoliage: boolean;
  /** Emits a ribbon. A painted path is a colour field and no geometry. */
  readonly draw: boolean;
  /**
   * Wears the ground it runs over — `Terrain.trampleAt` reads it as the colour
   * of packed dirt. The STRENGTH is per path (`Road.wear`), because two tracks
   * of one kind are walked different amounts; this only says whether the path
   * paints at all.
   */
  readonly wears: boolean;
}

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
  /** What this path is for. See `PathRoles`. */
  readonly roles: PathRoles;
  /**
   * How much loose stone and stick the corridor throws to its sides, 0..1.
   *
   * Issue #142 asks for "path foliage (stones and sticks)", and §7 is right
   * that it is not a new placer: `props.ts` already measures how far a column
   * lies outside the nearest rim, once, and spends it keeping things OFF. This
   * is the same number read the other way — a scatter rule that WANTS the
   * corridor, in the same pass, on the same candidates.
   *
   * AT THE VERGE AND NOT DOWN THE MIDDLE, which is `RoadNetwork.litterAt`'s
   * job rather than this number's: wheels and feet sweep a carriageway clear
   * and what they sweep ends up at its edge. This only says how much there is.
   */
  readonly litter: number;
  /**
   * THERE IS NO `disrepair` FIELD, AND THAT IS A MEASUREMENT.
   *
   * Issue #142 asks for "path quality (cracks, potholes)" and says to decide
   * colour against geometry up front rather than discover it. Both answers are
   * no, and the second one had to be built to find out:
   *
   * GEOMETRY is ruled out on the same grounds the file's header gives for
   * everything else. The deck IS the collision surface — `surfaceAt` and the
   * ribbon are two halves of one function — so a pothole would have to go
   * through `surfaceOf` or reopen issue #15, and every dip is something the
   * hero walks into against a `MAX_STEP_UP` of 0.5.
   *
   * COLOUR was built, captured and removed. A patch hashed on a 3-unit cell and
   * multiplied into `sectionColour` is invisible, and not because it is too
   * subtle: the ribbon carries VERTEX colours on nine vertices per ring at the
   * router's ~3-unit spacing, so any per-cell value is interpolated across six
   * units of road and arrives as a gradient rather than as a patch — and the
   * per-unit mottle already in there swings 0.86..1.16, which is a wider band
   * than the damage. Captured at 26% darkening on 6% of cells (the intended
   * setting) and again at 60% on 50%, the foreground road is the same picture
   * either way.
   *
   * So a pothole needs a TEXTURE, which §5 defers for a real reason: the ribbon
   * is one merged geometry on the terrain material and a texture is either a
   * second material (a draw call plus a shadow pass) or a UV channel and an
   * atlas on the terrain material for the whole world. Subdividing the ribbon
   * instead is the change that made the road read as torn paper — see `XS` in
   * town-parts.ts. Nobody should spend a week on the other one.
   */
  /** The colours the section is painted from. */
  readonly palette: PathPalette;
}

/** A built, drawn, carved path — the cart road and everything shaped like it. */
const BUILT_ROLES: PathRoles = {
  surface: true, refusesBuilt: true, refusesFoliage: true, draw: true, wears: false,
};
/**
 * A beaten track: a colour on the ground and a rule about foliage, nothing else.
 * See `PathRoles` for why it must not refuse what is built beside it.
 */
const WORN_ROLES: PathRoles = {
  surface: false, refusesBuilt: false, refusesFoliage: true, draw: false, wears: true,
};
/**
 * A PAVED street, painted into a deck that is already flat.
 *
 * The same roles as a beaten track minus the wearing: flagstones are laid, not
 * worn, so the colour comes from the surface the builder paints rather than
 * from a dirt field. It refuses no built thing for exactly the reason a track
 * does not — the planner that drew these streets is the one that placed the
 * lamps standing halfway along them.
 */
const PAVED_ROLES: PathRoles = {
  surface: false, refusesBuilt: false, refusesFoliage: true, draw: false, wears: false,
};

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
  /** Half-width of the flat part. The road is 2.8; a footpath is 1.4. */
  halfWidth: number;
  /**
   * Width of the ramp outside it, if the road's four-fifths is not right.
   *
   * A beaten track uses this: its soft edge is not a verge in the earthworks
   * sense, but it is exactly the same SHAPE — full strength over the middle and
   * fading to nothing at the rim — so it is the same two numbers. See
   * `trackProfile`.
   */
  verge?: number;
  carve?: PathCarve;
  furniture?: 'road' | 'none';
  bridges?: boolean;
  roles?: PathRoles;
  litter?: number;
  palette?: PathPalette;
}): PathProfile {
  const deckHalf = opts.halfWidth;
  // 2.2 / 2.8 on the road: the verge is about four fifths of the carriageway,
  // which is what makes a corridor read as built earth rather than as a strip.
  const verge = opts.verge ?? deckHalf * (2.2 / 2.8);
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
    roles: opts.roles ?? BUILT_ROLES,
    litter: opts.litter ?? 0,
    palette: opts.palette ?? CART_PALETTE,
  };
}

/**
 * THE CART ROAD — the profile every number above was reverse-engineered from.
 */
export const ROAD_PROFILE = pathProfile({
  id: 'path:road',
  halfWidth: 2.8,
  // A cart road is gravel over packed earth and it sheds: 0.35 puts a stone or
  // a fallen stick on about a third of the verge candidates the scatter pass
  // was going to reject anyway, which reads as a used road rather than as a
  // strip of clean geometry laid on a lawn.
  litter: 0.35,
});

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
  // MORE than the road's, and that is the difference between the two surfaces
  // rather than an accident: nobody grades a footpath, so what falls on it
  // stays. It is also the whole of what "path foliage" means for a path with no
  // furniture and no bridges — the stones and sticks ARE its detail.
  litter: 0.6,
  palette: FOOT_PALETTE,
});

/**
 * A SETTLEMENT'S BEATEN TRACK — the ground its own people have walked flat.
 *
 * This is the second of the three mechanisms issue #142 names, folded in: it
 * was `GroundPatch.paths`, a flat array of line segments inside terrain.ts that
 * only the colour pass could see, so no placer in the world knew a camp had a
 * thoroughfare down the middle of it and grass grew straight through it.
 *
 * It carves nothing, draws nothing and refuses nothing built — see `WORN_ROLES`
 * and the note on `PathRoles`. What it does is paint, and keep foliage off.
 *
 * WIDTH IS PER TRACK, so this is a factory rather than a constant: the camp's
 * thoroughfare is 4.4 half-width and its tent lines are 2.4, and those numbers
 * are `WEAR` in towns.ts, chosen against what the layout puts at the end of
 * each one. The rim IS that half-width — a beaten track has no verge, so
 * `deckHalf` is what the caller asked for and `verge` is derived as usual and
 * then ignored by every role this profile claims.
 */
/**
 * A FLAGGED STREET — the third of the three mechanisms issue #142 names.
 *
 * It was `SkyPlan.paths`, a list of `[x0, z0, x1, z1]` that `buildRock` walked
 * to decide which voxel cells to paint as flagstone, and nothing else on the
 * island could see it: the placer there was handed `NO_ROADS`, a clearance
 * stub that answers Infinity to everything, so it genuinely believed there was
 * no path anywhere and planted oaks in the middle of the streets.
 *
 * A KERB AND NOT A VERGE. The painting test is hard-edged — a cell is flagstone
 * or it is turf — so `deckEdge` has to land exactly on the half-width the
 * builder used. It gets a third of a voxel cell (`CELL` is 1.2 on the island)
 * of ramp, which is the narrowest edge that grid can represent at all, and
 * `deckHalf` takes the rest. Everything the profile derives from a verge is
 * then in proportion and nothing has to special-case a zero.
 */
export function flagstoneProfile(halfWidth: number): PathProfile {
  const kerb = 0.4;
  return pathProfile({
    id: 'path:flagstone',
    halfWidth: halfWidth - kerb,
    verge: kerb,
    carve: 'none',
    furniture: 'none',
    bridges: false,
    roles: PAVED_ROLES,
  });
}

export function trackProfile(halfWidth: number): PathProfile {
  // 0.45 / 0.55 IS THE EXISTING SOFT EDGE, and it is the reason this fold-in
  // costs no pixel of colour. `Terrain.trampleAt` faded a track with
  // `1 - smoothstep(hw * 0.45, hw, d)`: full strength over the middle 45% of
  // its width, gone at the rim. Those are a core and a ramp — the same two
  // numbers a carriageway has — so `deckHalf` is 0.45 of the track and
  // `deckEdge` lands exactly on the half-width the caller asked for.
  return pathProfile({
    id: 'path:track',
    halfWidth: halfWidth * 0.45,
    verge: halfWidth * 0.55,
    carve: 'none',
    furniture: 'none',
    bridges: false,
    roles: WORN_ROLES,
  });
}
