/**
 * TOWNS AS CONTENT (spec §4.1) — the `SiteSpec` table in `src/world/towns.ts`,
 * moved out of TypeScript and into data.
 *
 * WHAT MOVED AND WHAT DID NOT is the whole of the engine/content line. A town's
 * NAME, its sign, how big it is, what colour its compass chip is, whether it
 * wants water in its footprint and which layout builds it are all statements
 * about what exists — content. Siting it against the height field, routing the
 * road to it, cutting the flatten disc, wearing the ground down to mud and
 * painting sixty thousand voxels are behaviour, and they stay in `world/`. The
 * layout is SELECTED by name (`"layout": "camp"`) from the `town-layout` factory
 * kind, which is content/types.ts §4.6's rule: data chooses a behaviour, it never
 * supplies one.
 *
 * TWO FIELDS EXIST TO KILL TWO POSITIONAL CONVENTIONS, and they are the reason
 * this type is worth more than a straight transcription of the old table.
 * `SITES[0]` is the start town today and `SITES`' order is placement order — both
 * facts about an ARRAY INDEX, which spec §4.2 forbids for exactly the reason ids
 * exist: an index moves the moment content is reordered or split across packages,
 * and nothing about the move says so. `start: true` and `order` say what was
 * meant. `validate()` below then enforces the invariant the array made
 * structurally impossible to break — exactly one start town — because a rule that
 * used to be guaranteed by a data structure has to be guaranteed by a check once
 * the data structure is gone.
 */

import type { ContentAsset, ContentId, ContentText, ContentTypeDef, ParseCtx, ValidateCtx } from '../types';
import { bool, hexColor, num, obj, opt, readerFor, str, text } from '../schema';
import { isKnownTextKey } from '../text';

/** The factory kind a town's `layout` selects. `town-layout/camp`, `…/hamlet`. */
export const TOWN_LAYOUT_KIND = 'town-layout';

/** A layout name: the same narrow alphabet as the `name` half of an id. */
const LAYOUT_RE = /^[a-z][a-z0-9-]*$/;

export interface TownData {
  /**
   * What a fingerpost arm reads. Short, upper-case, <= 10 characters and inside
   * the 3x5 voxel font — see the `town.*.sign` block in src/i18n/en.ts, which is
   * where that constraint is stated and where a translator meets it. It is a
   * separate string from the display name rather than a truncation of it because
   * a carver and a HUD have nothing in common: "Redbriar Mill" is the name and
   * "REDBRIAR" is what fits on a plank.
   */
  readonly sign: ContentText;
  /** Which registered `town-layout` builds it — `camp`, `hamlet`. */
  readonly layout: string;
  /** The nominal footprint radius every distance test uses. Always a circle. */
  readonly radius: number;
  /**
   * How far the BUILT perimeter actually reaches — and DELIBERATELY NOT AUTHORED
   * for either shipped town.
   *
   * The Encampment's is `CAMP_WALL_HALF * Math.SQRT2` in `src/world/towns.ts`:
   * the corners of a square wall reach 41% further than its sides, and the number
   * is derived from the same constant that builds the wall geometry. Copying
   * 23.76 into JSON forks a load-bearing number — move the wall and the data
   * silently keeps the old reach, which shows up as trees growing in the corners
   * of the camp and corner runs standing on ground the flatten only levelled 88%
   * of the way. The thing that knows how far a wall's corners reach is the layout
   * that built it.
   *
   * So this is an OVERRIDE and not a value: absent means "ask the layout", which
   * is what both shipped towns say. A settlement whose perimeter is not a
   * function of its layout — a wall content placed by hand — can state it.
   */
  readonly outerRadius?: number;
  /**
   * How far out nothing hostile may SPAWN — and, like `outerRadius`, an OVERRIDE
   * rather than a value: absent means "derive it from what was built", which is
   * `outerRadius + TOWN_NO_SPAWN_MARGIN` (src/world/safe-zones.ts, where the
   * margin is argued and measured). Neither shipped town authors one.
   *
   * A settlement gets a keep-out BY DEFAULT because a settlement is somewhere
   * the player is meant to be able to stand still. An open-world point of
   * interest does not, and states one when its designer decides it should — see
   * `SafeZone` in src/core/types.ts for that split, and for the rule this is
   * only half of: a hostile already hunting the player follows them in.
   *
   * 0 is a real value and switches the zone OFF, for a settlement that is meant
   * to be under siege. That is why the range starts there rather than at 1: a
   * lawless outpost is a thing content should be able to say without the engine
   * needing a second field to say it with.
   */
  readonly noSpawnRadius?: number;
  /** The compass chip's colour, as a number the engine already wanted. */
  readonly color: number;
  /**
   * Prefer a site with water in the footprint's outer ring rather than avoiding
   * one. Scenery on the face of it, and load-bearing underneath: a town across
   * water is a town whose road has to cross it, which is what puts a BRIDGE in
   * the network reliably instead of by luck.
   */
  readonly waterside: boolean;
  /**
   * Placement order, ascending. Replaces `SITES`' array position — see the header.
   * Ties are a `bad-field` finding rather than an arbitrary winner.
   */
  readonly order: number;
  /**
   * The town the player starts on the road out of. Exactly one, checked below.
   * Replaces `SITES[0]` — see the header.
   */
  readonly start: boolean;
}

/**
 * Registered `town-layout` names, published by the composition root.
 *
 * `ValidateCtx` carries the content and no factory table, and widening it is the
 * wrong fix: reference existence is a question about CONTENT and is answered
 * centrally, where "does the engine implement this behaviour" is a question about
 * the BUILD. So the runtime tells the type what it registered, and the type keeps
 * the diagnostic — which matters, because the type is the only thing that knows
 * the finding belongs to `data.layout` rather than to the asset in general.
 *
 * NULL MEANS "NOBODY SAID", AND THE CHECK IS THEN SKIPPED — the same discipline
 * as `ValidateOptions.tests` being omittable. A headless tool that validates
 * content without constructing a world registers no layouts, and a run that
 * reported every town as `unknown-factory` would be a run nobody could read.
 *
 * The set is module-level, so two runtimes in one process publish the union of
 * their factories. That can only ever make this check more permissive; it can
 * never invent a false `unknown-factory`, which is the direction that matters.
 */
let knownLayouts: ReadonlySet<string> | null = null;

export function setKnownTownLayouts(names: Iterable<string>): void {
  knownLayouts = new Set(names);
}

function parse(body: unknown, ctx: ParseCtx): TownData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);
  return {
    sign: text(b.sign, r.at('sign')),
    layout: str(b.layout, r.at('layout'), {
      min: 1,
      max: 64,
      pattern: LAYOUT_RE,
      what: 'a town layout name',
    }),
    // Ranges are generous on purpose: they are a guard against untrusted JSON
    // (spec §22), not a design opinion. The shipped towns are 19 and 15.
    radius: num(b.radius, r.at('radius'), { min: 1, max: 500, what: 'a footprint radius' }),
    outerRadius: opt(b.outerRadius, r.at('outerRadius'), (v, c) =>
      num(v, c, { min: 1, max: 1000, what: 'a built perimeter radius' })),
    noSpawnRadius: opt(b.noSpawnRadius, r.at('noSpawnRadius'), (v, c) =>
      num(v, c, { min: 0, max: 1000, what: 'a no-spawn radius' })),
    color: hexColor(b.color, r.at('color')),
    waterside: opt(b.waterside, r.at('waterside'), bool) ?? false,
    order: num(b.order, r.at('order'), { min: 0, max: 10000, what: 'a placement order' }),
    start: opt(b.start, r.at('start'), bool) ?? false,
  };
}

/**
 * A town points at nothing today.
 *
 * Implemented rather than omitted so that the day one carries a reference — the
 * quest giver who lives there, the zone its gate opens onto — there is a function
 * to add it to and the graph picks it up with no other change. An empty
 * generator here and an absent `refs` are identical to the loader; the difference
 * is where the next author looks.
 */
function* refs(_data: TownData): Iterable<ContentId> {
  // Nothing yet. Note the direction the shipped content DOES point: `npc:gain`
  // names his town, not the other way round, so a settlement can be authored
  // without knowing who will stand in it.
}

function validate(asset: ContentAsset<TownData>, ctx: ValidateCtx): void {
  if (knownLayouts !== null && !knownLayouts.has(asset.data.layout)) {
    ctx.report({
      severity: 'error',
      code: 'unknown-factory',
      message: `no "${TOWN_LAYOUT_KIND}/${asset.data.layout}" is registered`,
      field: 'data.layout',
      fix: `defineFactory("${TOWN_LAYOUT_KIND}", "${asset.data.layout}", …), or use one that exists`,
    });
  }

  // --- the two whole-table rules -------------------------------------------
  // Run ONCE, from the first town in load order, rather than once per asset:
  // "there are two start towns" is one finding about the set, and reporting it
  // from every member would print it N times with N different asset ids while
  // the sink's dedupe (code, assetId, field) can do nothing about it.
  const towns = ctx.content.all<TownData>('town');
  if (towns.length === 0 || towns[0].id !== asset.id) return;

  const starts = towns.filter((tn) => tn.data.start);
  if (starts.length !== 1) {
    ctx.report({
      severity: 'error',
      code: 'bad-field',
      message:
        starts.length === 0
          ? 'no town declares "start": true'
          : `${starts.length} towns declare "start": true (${starts.map((tn) => tn.id).join(', ')})`,
      field: 'data.start',
      related: starts.map((tn) => tn.id),
      fix: 'exactly one town is the one the player spawns on the road out of',
    });
  }

  const seen = new Map<number, ContentId>();
  for (const town of towns) {
    const first = seen.get(town.data.order);
    if (first !== undefined) {
      ctx.report({
        severity: 'warn',
        code: 'bad-field',
        message: `"${town.id}" and "${first}" both claim placement order ${town.data.order}`,
        assetId: town.id,
        field: 'data.order',
        related: [first],
        // A warn rather than an error: the world still builds, and the cost is
        // that which of the two is sited first depends on load order — which is
        // precisely the positional dependency `order` was added to remove.
        fix: 'give them distinct orders; placement order decides who picks a site first',
      });
      continue;
    }
    seen.set(town.data.order, town.id);
  }
}

export const TOWN_TYPE: ContentTypeDef<TownData> = {
  name: 'town',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'town:new-town',
    schema: 1,
    name: { text: { en: 'New Town' } },
    data: {
      sign: { text: { en: 'NEW TOWN' } },
      layout: 'hamlet',
      radius: 15,
      color: '#ffffff',
      waterside: false,
      order: 99,
      start: false,
    },
  },
};
