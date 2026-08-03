/**
 * BIOMES AS CONTENT — one asset per `BiomeId` in `src/world/terrain.ts`, and the
 * vegetation multipliers issue #50 already made a named number.
 *
 * A BIOME IS THE WORLD'S ONLY EXISTING NOTION OF "SOMEWHERE WITH ITS OWN
 * CHARACTER", which is why `world/nature.ts` chose it as its area key and why
 * this type exists at all: `props.ts` dispatches its whole scatter off the enum,
 * so a place that says "half the trees" has somewhere to say it. What is content
 * here is the CHARACTER — a name, whether this is where the player starts, how
 * thick the sward is. What stays engine is the classifier that decides which
 * column is which biome (height, snow weight, desert weight, a settlement's
 * wear), because that is a pure function of the seed and not a thing anyone
 * authors.
 *
 * THE SHIPPED VALUES ARE ALL 1, AND THAT IS WHAT MAKES THIS SAFE TO ADD.
 * Every parameter in nature.ts is a dimensionless MULTIPLIER whose default is
 * exactly 1, and `NatureField.setArea` DELETES an entry set to 1 rather than
 * storing it — so feeding it a table of ones leaves `bases` and `areas` empty,
 * `isDefault()` true, and `tools/test-nature.mjs`'s identity control reading a
 * drift of 0. The migration therefore cannot move a single blade of grass, and
 * it cannot do so by CONSTRUCTION rather than because the numbers happen to
 * match. Anything else would be a tuning change wearing a migration's clothes.
 *
 * TWO OF THE SEVEN ARE NOT WEATHER, and they carry a `synthetic` tag in the JSON
 * to say so. 'trampled' is the yard of a settlement — terrain.ts says exactly
 * that at the top of the file — and 'underwater' is decided by the column being
 * below the water line before any climate weight is consulted at all (the
 * classifier's first branch). They get assets because `BiomeId` is the area key
 * and an area with no asset is an area nothing can describe; the tag is how a
 * caller that wants CLIMATES asks for the five that are.
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from '../types';
import { bool, num, obj, opt, readerFor, record } from '../schema';
import { isKnownTextKey } from '../text';
// TYPE-ONLY, so it is erased at build time and adds no import edge at runtime —
// the same device `src/core/types.ts` uses on `StringKey`, and here it is
// load-bearing: the content runtime must not depend on the world (content/
// types.ts, "nothing here reaches for the DOM, three.js or the world"), and
// `world/nature.ts` reads `window.location` at module load.
import type { NatureParamId } from '../../world/nature';

/**
 * The vegetation parameters a biome may scale, spelled out because the runtime
 * table cannot be imported (see above).
 *
 * `_inSync` below is the compile-time tie between the two. It costs one boolean
 * in the bundle and it means a parameter added to `NATURE_PARAMS` — or one
 * renamed — is a BUILD FAILURE here rather than a field that silently stops
 * having any effect. A duplicated list with no check is the thing this codebase
 * calls a load-bearing number written down twice.
 */
export const NATURE_PARAM_NAMES = ['trees', 'grass', 'flowers', 'bushes', 'rocks', 'reeds'] as const;

export type NatureParamName = (typeof NATURE_PARAM_NAMES)[number];

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** A type error on this line means the list above and `NatureParamId` disagree. */
const _inSync: Exact<NatureParamName, NatureParamId> = true;
void _inSync;

const KNOWN_PARAMS: ReadonlySet<string> = new Set<string>(NATURE_PARAM_NAMES);

/**
 * The ceiling `NatureField` itself clamps to (`NatureParamDef.max`, 4 for every
 * parameter today). Repeated here so an out-of-range value is reported against
 * the FIELD that holds it — `data.nature.trees` — instead of being silently
 * clamped later with nothing to point at. The clamp downstream is still the
 * authority; this is the diagnostic.
 */
const NATURE_MAX = 4;

export interface BiomeData {
  /**
   * The area the player's first steps are in. Exactly one, checked below — the
   * same argument as `TownData.start`: an invariant that used to be implicit in
   * a data structure has to be a check once the data structure is gone.
   */
  readonly startArea: boolean;
  /**
   * Per-parameter multipliers ON TOP of the tuned baseline, keyed by
   * `NatureParamName`. 1 is "the world as tuned" — see the header for why every
   * shipped value is exactly that.
   *
   * PARTIAL, deliberately: an absent parameter is 1, which is the same statement
   * as writing 1 and is what `NatureField` stores either way. So a biome that
   * only has something to say about trees says only that.
   */
  readonly nature: Readonly<Partial<Record<NatureParamName, number>>>;
}

function parse(body: unknown, ctx: ParseCtx): BiomeData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);

  const raw = opt(b.nature, r.at('nature'), record(
    (v, c) => num(v, c, { min: 0, max: NATURE_MAX, what: 'a density multiplier' }),
    { key: /^[a-z][a-z0-9-]*$/, max: 64 },
  )) ?? {};

  const nature: Partial<Record<NatureParamName, number>> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PARAMS.has(key)) {
      // Named rather than dropped in silence: a misspelled parameter is a
      // density the author believes they set, and the symptom — a meadow that
      // looks exactly as it always did — is indistinguishable from success.
      r.at('nature').at(key).report(
        'error',
        'bad-field',
        `"${key}" is not a nature parameter`,
        `one of ${NATURE_PARAM_NAMES.join(', ')}`,
      );
      continue;
    }
    nature[key as NatureParamName] = raw[key];
  }

  return {
    startArea: opt(b.startArea, r.at('startArea'), bool) ?? false,
    nature,
  };
}

/** A biome points at nothing. Implemented for the reason town.ts's is. */
function* refs(_data: BiomeData): Iterable<ContentId> {
  // Nothing yet. A biome that named the enemies that spawn in it would put them
  // here, and the graph would pick it up with no other change.
}

function validate(asset: ContentAsset<BiomeData>, ctx: ValidateCtx): void {
  // Once, from the first biome in load order — see the same note in town.ts.
  const biomes = ctx.content.all<BiomeData>('biome');
  if (biomes.length === 0 || biomes[0].id !== asset.id) return;

  const starts = biomes.filter((bi) => bi.data.startArea);
  if (starts.length === 1) return;
  ctx.report({
    severity: 'error',
    code: 'bad-field',
    message:
      starts.length === 0
        ? 'no biome declares "startArea": true'
        : `${starts.length} biomes declare "startArea": true (${starts.map((bi) => bi.id).join(', ')})`,
    field: 'data.startArea',
    related: starts.map((bi) => bi.id),
    fix: 'exactly one area is where the world starts',
  });
}

export const BIOME_TYPE: ContentTypeDef<BiomeData> = {
  name: 'biome',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'biome:new-area',
    schema: 1,
    name: { text: { en: 'New Area' } },
    data: { startArea: false, nature: { trees: 1, grass: 1 } },
  },
};
