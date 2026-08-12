/**
 * Biomes as content — one asset per `BiomeId` (issue #50). The classifier that
 * decides which column is which biome stays engine. 'trampled' and 'underwater'
 * are not weather and carry a `synthetic` tag so a caller can ask for climates only.
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from '../types';
import { bool, num, obj, opt, readerFor, record } from '../schema';
import { isKnownTextKey } from '../text';
// TYPE-ONLY and load-bearing: `world/nature.ts` reads `window.location` at module
// load, and the content runtime must not depend on the world.
import type { NatureParamId } from '../../world/nature';

/**
 * Spelled out because the runtime table cannot be imported (see above).
 * `_inSync` below makes a drift from `NATURE_PARAMS` a build failure.
 */
export const NATURE_PARAM_NAMES = ['trees', 'grass', 'flowers', 'bushes', 'rocks', 'reeds'] as const;

export type NatureParamName = (typeof NATURE_PARAM_NAMES)[number];

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** A type error on this line means the list above and `NatureParamId` disagree. */
const _inSync: Exact<NatureParamName, NatureParamId> = true;
void _inSync;

const KNOWN_PARAMS: ReadonlySet<string> = new Set<string>(NATURE_PARAM_NAMES);

/** Mirrors `NatureParamDef.max` so an out-of-range value names its own field. The downstream clamp is still the authority. */
const NATURE_MAX = 4;

export interface BiomeData {
  /** The area the player's first steps are in. Exactly one, checked below. */
  readonly startArea: boolean;
  /** Multipliers on top of the tuned baseline; 1 (or absent) is "the world as tuned". */
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
      // Named rather than dropped: a misspelled parameter looks exactly like success.
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
