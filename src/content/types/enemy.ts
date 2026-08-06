/**
 * WILD ENEMIES AS CONTENT — `ENEMY_DEFS`, `STATS` and the three `*_VARIANTS`
 * palettes in `src/combat/enemies.ts`, which are three tables about the same
 * three species kept in step by hand.
 *
 * THAT IS THE ARGUMENT FOR MOVING THEM, more than the JSON. A species today is an
 * entry in a flying/not list, a row in a stats record and a palette table named
 * after it in SCREAMING_CASE, and adding one means finding all three; the voxel
 * builder — the part that genuinely is code — is the fourth thing and the only
 * one that has to be. Here a species is ONE asset, and the builder is selected by
 * name off the `enemy-model` factory kind.
 *
 * THE VARIANT ARRAY'S ORDER IS LOAD-BEARING AND THERE ARE EXACTLY THREE.
 * `variantForHeight(dh)` in combat/enemies.ts returns an INDEX: 0 at mid
 * altitude, 1 in the highlands (above 11 over the water line), 2 in the lowlands
 * (below 2.5). So the list is not a set of palettes to choose from, it is a
 * three-element lookup table, and a species with two or four of them is a species
 * whose highland form is `undefined`. `parse` refuses the asset outright in that
 * case rather than padding — inventing a fourth palette is inventing content, and
 * the alternative failure is a crash inside a spawn, a long way from the file.
 *
 * WHAT DID NOT MOVE: the AI. Idle, wander, aggro, attack, the terrain probes, the
 * hp bar and the hit flash are behaviour and stay where they are. `aggro` here is
 * the RADIUS that behaviour reads, which is a number about this species and not a
 * rule about how anything chases.
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from '../types';
import { bool, enumOf, hexColor, isRecord, list, num, obj, opt, readerFor, str } from '../schema';
import type { Reader } from '../schema';
import { isKnownTextKey } from '../text';
// Type-only, so nothing at runtime imports core/types.ts — which pulls in
// three.js. See the same device, for the same reason, in biome.ts.
import type { ElementType } from '../../core/types';

/** The factory kind an enemy's `model` selects. `enemy-model/gloopling`, … */
export const ENEMY_MODEL_KIND = 'enemy-model';

/**
 * The `model` prefix that means "this wild thing wears a BEAST'S body".
 *
 * `beast-sproutle` is an ordinary `enemy-model` name — src/combat/enemies.ts
 * registers one per entry in `ALL_SPECIES`, so it is selected by name like every
 * other builder and an id nothing implements is the ordinary unknown-factory
 * diagnostic. The prefix is spelled out here because two files reason about it:
 * that registration loop, and `validate` below, which is what makes a `capture`
 * block on a Gloopling an error rather than a beast nobody can be given.
 *
 * A HYPHEN AND NOT A COLON, because a colon is what a content ID is made of
 * (`enemy:gloopling`) and a model name is not an id — it names a behaviour the
 * engine registered. `MODEL_RE` refuses the colon for exactly that reason.
 */
export const BEAST_MODEL_PREFIX = 'beast-';

const MODEL_RE = /^[a-z][a-z0-9-]*$/;

/**
 * The element union, spelled out because `core/types.ts` cannot be imported for
 * a VALUE here (it imports three.js at the top). `_inSync` is the compile-time
 * tie, exactly as in biome.ts: adding an element to the game and forgetting this
 * list is a build failure rather than a validation that quietly refuses the new
 * one.
 */
export const ELEMENT_NAMES = [
  'fire', 'water', 'grass', 'electric', 'ice',
  'rock', 'wind', 'shadow', 'light', 'dragon',
] as const;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** A type error on this line means the list above and `ElementType` disagree. */
const _inSync: Exact<(typeof ELEMENT_NAMES)[number], ElementType> = true;
void _inSync;

/**
 * How many palettes a species carries. Not a tunable — it is the arity of
 * `variantForHeight`. See the header.
 */
export const VARIANT_COUNT = 3;

/** One palette. Index 0 is mid, 1 is highland, 2 is lowland. */
export interface EnemyVariant {
  readonly element: ElementType;
  readonly main: number;
  readonly dark: number;
  readonly belly: number;
  readonly accent: number;
}

/**
 * WHAT IT TAKES TO BOND THIS ONE — absent on anything that cannot be bonded.
 *
 * IT DOES NOT NAME A SPECIES, and that omission is the design. What you catch is
 * what you fought: the body already says which beast this is (`model`, see
 * `BEAST_MODEL_PREFIX`), so a species named here as well would be a second answer
 * to the same question and the day the two disagreed the player would throw an
 * orb at a Sproutle and be handed a Drakelet.
 */
export interface EnemyCapture {
  /**
   * The weakest orb that may bond it, as an `ItemDef.orbTier` — 1 Tame, 2
   * Greater, 3 Ultra, 4 Master. Below it the orb always breaks, whatever the
   * animal's health: this is the issue's "stronger beasts require better orbs",
   * and it is a FLOOR rather than a modifier so that a player can read the
   * failure as "wrong tool" instead of as bad luck.
   */
  readonly minTier: number;
  /**
   * Divides the odds. 1 is an animal that comes quietly; the shipped roster runs
   * 1.0-2.2. See `captureChance` in src/combat/taming.ts for the whole formula —
   * this is the only half of it a designer sets.
   */
  readonly difficulty: number;
}

export interface EnemyData {
  /** Which registered `enemy-model` builds the voxel body. */
  readonly model: string;
  /** Flyers hover and path in three dimensions; the rest walk the height field. */
  readonly flying: boolean;
  readonly hp: number;
  readonly atk: number;
  /** World units per second. */
  readonly speed: number;
  /** XP awarded for the kill. */
  readonly xp: number;
  /**
   * Collision radius, world units.
   *
   * On a `beast-…` body these two must match what the rig measures for itself
   * (`BeastRig.radius`/`height`), because the rig is what the player sees and
   * these are what the game reaches with. They are still authored rather than
   * derived, since content cannot build a rig to ask — the renderer is on the
   * far side of a wall this package does not cross. `bun tools/probe.mjs taming`
   * measures the pair and fails on a drift.
   */
  readonly radius: number;
  /** Standing height, world units — where the hp bar floats. See `radius`. */
  readonly height: number;
  /** How far away it notices the player, world units. */
  readonly aggro: number;
  /**
   * EXACTLY three, in `variantForHeight` order — mid, highland, lowland.
   *
   * ON A `beast-…` BODY ONLY THE `element` IS READ. A beast paints itself: its
   * colours live in its species file beside the shape they belong to, so a
   * palette here would be a second, unused answer that a reader would reasonably
   * expect to see on screen. The three entries are still required — the array is
   * a lookup table `variantForHeight` indexes, not a choice — and the honest way
   * to author them for a beast is three identical rows carrying its element.
   */
  readonly variants: readonly EnemyVariant[];
  /** What it takes to bond it, or absent where it cannot be. See `EnemyCapture`. */
  readonly capture?: EnemyCapture;
}

/** Registered `enemy-model` names. See the long note at `knownLayouts` in town.ts. */
let knownModels: ReadonlySet<string> | null = null;

export function setKnownEnemyModels(names: Iterable<string>): void {
  knownModels = new Set(names);
}

const element = enumOf(ELEMENT_NAMES);

function readVariant(value: unknown, ctx: Reader): EnemyVariant {
  if (!isRecord(value)) {
    ctx.report(
      'error',
      'bad-field',
      'expected a palette object',
      'write { "element": "grass", "main": "#6fd84f", "dark": …, "belly": …, "accent": … }',
    );
  }
  // An annotation, not a cast: the empty record makes every reader below report
  // its own missing field against its own path, so one malformed palette says
  // which five things it was missing rather than only that it was malformed.
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    element: element(v.element, ctx.at('element')),
    main: hexColor(v.main, ctx.at('main')),
    dark: hexColor(v.dark, ctx.at('dark')),
    belly: hexColor(v.belly, ctx.at('belly')),
    accent: hexColor(v.accent, ctx.at('accent')),
  };
}

/**
 * `ORB_TIERS` in src/core/items.ts, as a bound this file may state.
 *
 * A LITERAL rather than an import, for the reason `ELEMENT_NAMES` above is one:
 * core/items.ts reaches core/types.ts, which imports three.js at the top, and
 * nothing in src/content may pull the renderer in to validate a number. Four is
 * also not a tunable — it is how many orbs the issue asks for — so the failure
 * mode of the two drifting is a fifth orb nobody can require, which the
 * out-of-range diagnostic here names precisely.
 */
const MAX_ORB_TIER = 4;

function readCapture(value: unknown, ctx: Reader): EnemyCapture {
  if (!isRecord(value)) {
    ctx.report(
      'error',
      'bad-field',
      'expected a capture object',
      'write { "minTier": 1, "difficulty": 1.4 }',
    );
  }
  // The same annotation-not-a-cast device `readVariant` uses: an empty record
  // makes each reader below report its own missing field against its own path.
  const c: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    minTier: num(c.minTier, ctx.at('minTier'), { min: 1, max: MAX_ORB_TIER, what: 'an orb tier' }),
    // Floored at 1: a difficulty below it would make an animal EASIER than one
    // that comes quietly, which the formula already expresses as a low minTier.
    difficulty: num(c.difficulty, ctx.at('difficulty'), { min: 1, max: 20, what: 'a capture difficulty' }),
  };
}

function parse(body: unknown, ctx: ParseCtx): EnemyData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);

  const variants = list(readVariant, { min: VARIANT_COUNT, max: VARIANT_COUNT })(
    b.variants,
    r.at('variants'),
  );
  if (variants.length !== VARIANT_COUNT) {
    // THE ONE UNRECOVERABLE BODY IN THIS TYPE. Every other field degrades to a
    // documented fallback and costs one diagnostic; a palette table of the wrong
    // length cannot, because `variantForHeight` indexes it and the failure lands
    // as `undefined.main` inside a spawn. Returning null skips this species and
    // keeps the package (types.ts, `ContentTypeDef.parse`).
    r.at('variants').report(
      'error',
      'bad-field',
      `needs exactly ${VARIANT_COUNT} palettes (mid, highland, lowland); got ${variants.length}`,
      'variantForHeight() indexes this list — it is a lookup table, not a choice',
    );
    return null;
  }

  return {
    model: str(b.model, r.at('model'), { min: 1, max: 64, pattern: MODEL_RE, what: 'an enemy model name' }),
    flying: opt(b.flying, r.at('flying'), bool) ?? false,
    // The caps are guards on untrusted JSON (spec §22), not balance opinions;
    // the shipped roster runs 26-62 hp and 2.3-5.2 units per second.
    hp: num(b.hp, r.at('hp'), { min: 1, max: 1_000_000, what: 'hit points' }),
    atk: num(b.atk, r.at('atk'), { min: 0, max: 100_000, what: 'an attack stat' }),
    speed: num(b.speed, r.at('speed'), { min: 0, max: 200, what: 'a movement speed' }),
    xp: num(b.xp, r.at('xp'), { min: 0, max: 1_000_000, what: 'an xp award' }),
    radius: num(b.radius, r.at('radius'), { min: 0.05, max: 100, what: 'a collision radius' }),
    height: num(b.height, r.at('height'), { min: 0.05, max: 100, what: 'a standing height' }),
    aggro: num(b.aggro, r.at('aggro'), { min: 0, max: 500, what: 'an aggro radius' }),
    variants,
    capture: opt(b.capture, r.at('capture'), readCapture),
  };
}

/**
 * An enemy points at nothing today.
 *
 * `element` and `model` are NOT references and must never become ones: an
 * element is a value in a union the combat maths switches on, and a model names
 * an engine behaviour. Both would parse as the `name` half of an id and neither
 * has an asset to resolve to — see content/types.ts on why the type lives inside
 * an id, and validate.ts's `checkWhen`, which only treats a string as a ref when
 * its type half names a registered type.
 */
function* refs(_data: EnemyData): Iterable<ContentId> {
  // Nothing yet. A species that named its drop table would put it here.
}

function validate(asset: ContentAsset<EnemyData>, ctx: ValidateCtx): void {
  if (knownModels !== null && !knownModels.has(asset.data.model)) {
    ctx.report({
      severity: 'error',
      code: 'unknown-factory',
      message: `no "${ENEMY_MODEL_KIND}/${asset.data.model}" is registered`,
      field: 'data.model',
      fix: `defineFactory("${ENEMY_MODEL_KIND}", "${asset.data.model}", …), or use one that exists`,
    });
  }
  // A CAPTURE BLOCK ON A BODY THAT IS NOT A BEAST'S. Bonding hands the player the
  // species whose body this thing wears (see `EnemyCapture`), so a Gloopling with
  // a capture block is an orb that would succeed and grant nothing. Caught here
  // rather than at the throw, where the only honest thing left to do is refuse
  // silently in front of a player who spent an orb.
  if (asset.data.capture && !asset.data.model.startsWith(BEAST_MODEL_PREFIX)) {
    ctx.report({
      severity: 'error',
      code: 'bad-field',
      message: `"${asset.id}" can be bonded but wears "${asset.data.model}", which is not a beast's body`,
      field: 'data.capture',
      fix: `give it a "${BEAST_MODEL_PREFIX}<species>" model, or drop the capture block`,
    });
  }
}

export const ENEMY_TYPE: ContentTypeDef<EnemyData> = {
  name: 'enemy',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'enemy:new-beast',
    schema: 1,
    name: { text: { en: 'New Beast' } },
    data: {
      model: 'gloopling',
      flying: false,
      hp: 30, atk: 6, speed: 2.5, xp: 8,
      radius: 0.5, height: 1, aggro: 9,
      variants: [
        { element: 'grass', main: '#ffffff', dark: '#888888', belly: '#cccccc', accent: '#000000' },
        { element: 'grass', main: '#ffffff', dark: '#888888', belly: '#cccccc', accent: '#000000' },
        { element: 'grass', main: '#ffffff', dark: '#888888', belly: '#cccccc', accent: '#000000' },
      ],
    },
  },
};
