/** Towns as content — the `SiteSpec` table from `src/world/towns.ts`, as data. */

import type {
  ContentAsset,
  ContentId,
  ContentText,
  ContentTypeDef,
  ParseCtx,
  ValidateCtx,
} from "../types";
import { bool, hexColor, num, obj, opt, readerFor, str, text } from "../schema";
import { isKnownTextKey } from "../text";

/** The factory kind a town's `layout` selects. `town-layout/camp`, `…/hamlet`. */
export const TOWN_LAYOUT_KIND = "town-layout";

/** The factory kind a CARRIED town's `layout` selects — `carried-layout/skyhaven`. */
export const CARRIED_LAYOUT_KIND = "carried-layout";

/** A layout name: the same narrow alphabet as the `name` half of an id. */
const LAYOUT_RE = /^[a-z][a-z0-9-]*$/;

export interface TownData {
  /** Fingerpost text: upper-case, <= 10 chars, inside the 3x5 voxel font. */
  readonly sign: ContentText;
  /** Which registered `town-layout` builds it — `camp`, `hamlet`. */
  readonly layout: string;
  /** The nominal footprint radius every distance test uses. Always a circle. */
  readonly radius: number;
  /** OVERRIDE for the built perimeter's reach; absent means "ask the layout". */
  readonly outerRadius?: number;
  /**
   * OVERRIDE for the hostile keep-out radius; absent derives
   * `outerRadius + TOWN_NO_SPAWN_MARGIN`. 0 switches the zone off.
   */
  readonly noSpawnRadius?: number;
  readonly color: number;
  /** Prefer a site with water in the footprint's outer ring — this is what puts bridges in the network. */
  readonly waterside: boolean;
  /** Placement order, ascending. Ties are a `bad-field` finding. */
  readonly order: number;
  /** The town the player starts on the road out of. Exactly one, checked below. */
  readonly start: boolean;
  /**
   * Not sited on the ground — a carrier holds it (issue #68). `planSettlements`
   * skips these, so they take no road slot; the carrier reads them itself.
   */
  readonly carried: boolean;
}

/**
 * Registered `town-layout` names, published by the composition root.
 * Null means "nobody said" and skips the check — a headless validator registers none.
 */
let knownLayouts: ReadonlySet<string> | null = null;

export function setKnownTownLayouts(names: Iterable<string>): void {
  knownLayouts = new Set(names);
}

/**
 * The same for CARRIED settlements. A separate set because a carried layout takes
 * a deck and local origin, not a road network and a height-field site.
 */
let knownCarried: ReadonlySet<string> | null = null;

export function setKnownCarriedLayouts(names: Iterable<string>): void {
  knownCarried = new Set(names);
}

function parse(body: unknown, ctx: ParseCtx): TownData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);
  return {
    sign: text(b.sign, r.at("sign")),
    layout: str(b.layout, r.at("layout"), {
      min: 1,
      max: 64,
      pattern: LAYOUT_RE,
      what: "a town layout name",
    }),
    // Ranges are a guard against untrusted JSON, not a design opinion.
    radius: num(b.radius, r.at("radius"), { min: 1, max: 500, what: "a footprint radius" }),
    outerRadius: opt(b.outerRadius, r.at("outerRadius"), (v, c) =>
      num(v, c, { min: 1, max: 1000, what: "a built perimeter radius" }),
    ),
    noSpawnRadius: opt(b.noSpawnRadius, r.at("noSpawnRadius"), (v, c) =>
      num(v, c, { min: 0, max: 1000, what: "a no-spawn radius" }),
    ),
    color: hexColor(b.color, r.at("color")),
    waterside: opt(b.waterside, r.at("waterside"), bool) ?? false,
    order: num(b.order, r.at("order"), { min: 0, max: 10000, what: "a placement order" }),
    start: opt(b.start, r.at("start"), bool) ?? false,
    carried: opt(b.carried, r.at("carried"), bool) ?? false,
  };
}

/** A town points at nothing today; NPCs name their town, not the reverse. */
function* refs(_data: TownData): Iterable<ContentId> {}

function validate(asset: ContentAsset<TownData>, ctx: ValidateCtx): void {
  const kind = asset.data.carried ? CARRIED_LAYOUT_KIND : TOWN_LAYOUT_KIND;
  const known = asset.data.carried ? knownCarried : knownLayouts;
  if (known !== null && !known.has(asset.data.layout)) {
    ctx.report({
      severity: "error",
      code: "unknown-factory",
      message: `no "${kind}/${asset.data.layout}" is registered`,
      field: "data.layout",
      fix: `defineFactory("${kind}", "${asset.data.layout}", …), or use one that exists`,
    });
  }

  // Whole-table rules run ONCE, from the first town in load order: one finding
  // about the set, not one per member (the sink dedupes on assetId).
  const towns = ctx.content.all<TownData>("town");
  if (towns.length === 0 || towns[0].id !== asset.id) {
    return;
  }

  const starts = towns.filter((tn) => tn.data.start);
  if (starts.length !== 1) {
    ctx.report({
      severity: "error",
      code: "bad-field",
      message:
        starts.length === 0
          ? 'no town declares "start": true'
          : `${starts.length} towns declare "start": true (${starts.map((tn) => tn.id).join(", ")})`,
      field: "data.start",
      related: starts.map((tn) => tn.id),
      fix: "exactly one town is the one the player spawns on the road out of",
    });
  }

  const seen = new Map<number, ContentId>();
  for (const town of towns) {
    const first = seen.get(town.data.order);
    if (first !== undefined) {
      ctx.report({
        severity: "warn",
        code: "bad-field",
        message: `"${town.id}" and "${first}" both claim placement order ${town.data.order}`,
        assetId: town.id,
        field: "data.order",
        related: [first],
        // Warn, not error: the world builds, but siting order falls back to load order.
        fix: "give them distinct orders; placement order decides who picks a site first",
      });
      continue;
    }
    seen.set(town.data.order, town.id);
  }
}

export const TOWN_TYPE: ContentTypeDef<TownData> = {
  name: "town",
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: "town:new-town",
    schema: 1,
    name: { text: { en: "New Town" } },
    data: {
      sign: { text: { en: "NEW TOWN" } },
      layout: "hamlet",
      radius: 15,
      color: "#ffffff",
      waterside: false,
      order: 99,
      start: false,
    },
  },
};
