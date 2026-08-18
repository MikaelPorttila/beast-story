/**
 * Wild enemies as content. `variants` is a lookup table `variantForHeight` INDEXES:
 * exactly three, in order — mid, highland (>11 over water), lowland (<2.5).
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from "../types";
import { bool, enumOf, hexColor, isRecord, list, num, obj, opt, readerFor, str } from "../schema";
import type { Reader } from "../schema";
import { isKnownTextKey } from "../text";
// Type-only, so nothing at runtime imports core/types.ts — which pulls in three.js.
import type { ElementType, MountKind } from "../../core/types";

/** The factory kind an enemy's `model` selects. `enemy-model/gloopling`, … */
export const ENEMY_MODEL_KIND = "enemy-model";

/** `model` prefix meaning "wears a BEAST'S body". Hyphen, not colon: not a content id. */
export const BEAST_MODEL_PREFIX = "beast-";

const MODEL_RE = /^[a-z][a-z0-9-]*$/;

/** Spelled out because `core/types.ts` cannot be imported for a VALUE here (three.js). */
export const ELEMENT_NAMES = [
  "fire",
  "water",
  "grass",
  "electric",
  "ice",
  "rock",
  "wind",
  "shadow",
  "light",
  "dragon",
] as const;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** A type error on this line means the list above and `ElementType` disagree. */
const _inSync: Exact<(typeof ELEMENT_NAMES)[number], ElementType> = true;
void _inSync;

/** Not a tunable — it is the arity of `variantForHeight`. */
export const VARIANT_COUNT = 3;

/** One palette. Index 0 is mid, 1 is highland, 2 is lowland. */
export interface EnemyVariant {
  readonly element: ElementType;
  readonly main: number;
  readonly dark: number;
  readonly belly: number;
  readonly accent: number;
}

/** Absent on anything that cannot be bonded. Names no species — `model` already does. */
export interface EnemyCapture {
  /** Divides the odds; 1 comes quietly. Formula: `captureChance` in combat/taming.ts. */
  readonly difficulty: number;
}

export interface EnemyData {
  readonly model: string;
  /**
   * Which body's MANNERS it has, when they are not its own model's.
   *
   * The animator poses named parts, so a behaviour belongs to a SHAPE and not to
   * an id: absent, an enemy moves the way the body it wears moves. Naming
   * another one here is for an asset that wants a familiar silhouette to act
   * differently, and it is on the author to pick one whose parts exist.
   */
  readonly behaviour?: string;
  /** Flyers path in three dimensions; the rest walk the height field. */
  readonly flying: boolean;
  readonly hp: number;
  readonly atk: number;
  /** World units per second. */
  readonly speed: number;
  readonly xp: number;
  /** World units. On a `beast-…` body must match `BeastRig.radius`/`height`; `probe.mjs taming` guards it. */
  readonly radius: number;
  /** World units — where the hp bar floats. */
  readonly height: number;
  /** Notice distance, world units. */
  readonly aggro: number;
  /** Exactly three, in `variantForHeight` order. On a `beast-…` body only `element` is read. */
  readonly variants: readonly EnemyVariant[];
  readonly capture?: EnemyCapture;
  /**
   * HELD BY A BOND (Act 4, issue #163): only a rider on this KIND of mount can
   * hurt it — the gate is `CombatSystem.dealSkillDamage` — and the kind is also
   * its element: `ground` walks, `water` swims under the surface, `flying`
   * hovers. Content names the mount; nothing here asks the mount system.
   */
  readonly bond?: MountKind;
  /**
   * A BOND THAT CHANGES WITH ITS HEALTH (issue #166): the phase whose `hp` (a
   * fraction of max, descending) is the largest still at or above the enemy's
   * is the one it is in, and its `bond` replaces the field above. Rhune's three
   * phases, one per mount, are three rows; the host is told of each change.
   */
  readonly phases?: readonly EnemyPhase[];
}

export interface EnemyPhase {
  readonly hp: number;
  readonly bond: MountKind;
}

/** Registered `enemy-model` names; null skips the check. See town.ts. */
let knownModels: ReadonlySet<string> | null = null;

export function setKnownEnemyModels(names: Iterable<string>): void {
  knownModels = new Set(names);
}

const element = enumOf(ELEMENT_NAMES);
/** Spelled out for the same reason `ELEMENT_NAMES` is; `MOUNT_KINDS` lives beside three.js. */
const bond = enumOf(["ground", "water", "flying"] as const);

function readVariant(value: unknown, ctx: Reader): EnemyVariant {
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      "expected a palette object",
      'write { "element": "grass", "main": "#6fd84f", "dark": …, "belly": …, "accent": … }',
    );
  }
  // An annotation, not a cast: the empty record lets each reader name its own field.
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    element: element(v.element, ctx.at("element")),
    main: hexColor(v.main, ctx.at("main")),
    dark: hexColor(v.dark, ctx.at("dark")),
    belly: hexColor(v.belly, ctx.at("belly")),
    accent: hexColor(v.accent, ctx.at("accent")),
  };
}

function readCapture(value: unknown, ctx: Reader): EnemyCapture {
  if (!isRecord(value)) {
    ctx.report("error", "bad-field", "expected a capture object", 'write { "difficulty": 1.4 }');
  }
  const c: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    // Floored at 1; no floor on the ORB tier any more (issue #110).
    difficulty: num(c.difficulty, ctx.at("difficulty"), {
      min: 1,
      max: 20,
      what: "a capture difficulty",
    }),
  };
}

function readPhase(value: unknown, ctx: Reader): EnemyPhase {
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    ctx.report("error", "bad-field", "expected a phase object", 'write { "hp": 0.66, "bond": "water" }');
  }
  return {
    hp: num(v.hp, ctx.at("hp"), { min: 0, max: 1, what: "a health fraction" }),
    bond: bond(v.bond, ctx.at("bond")),
  };
}

function parse(body: unknown, ctx: ParseCtx): EnemyData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);

  const variants = list(readVariant, { min: VARIANT_COUNT, max: VARIANT_COUNT })(
    b.variants,
    r.at("variants"),
  );
  if (variants.length !== VARIANT_COUNT) {
    // Unrecoverable: a wrong-length table lands as `undefined.main` inside a spawn.
    r.at("variants").report(
      "error",
      "bad-field",
      `needs exactly ${VARIANT_COUNT} palettes (mid, highland, lowland); got ${variants.length}`,
      "variantForHeight() indexes this list — it is a lookup table, not a choice",
    );
    return null;
  }

  return {
    model: str(b.model, r.at("model"), {
      min: 1,
      max: 64,
      pattern: MODEL_RE,
      what: "an enemy model name",
    }),
    behaviour: opt(b.behaviour, r.at("behaviour"), (v, c) =>
      str(v, c, { min: 1, max: 64, pattern: MODEL_RE, what: "an enemy behaviour name" }),
    ),
    flying: opt(b.flying, r.at("flying"), bool) ?? false,
    // Caps are guards on untrusted JSON, not balance opinions.
    hp: num(b.hp, r.at("hp"), { min: 1, max: 1_000_000, what: "hit points" }),
    atk: num(b.atk, r.at("atk"), { min: 0, max: 100_000, what: "an attack stat" }),
    speed: num(b.speed, r.at("speed"), { min: 0, max: 200, what: "a movement speed" }),
    xp: num(b.xp, r.at("xp"), { min: 0, max: 1_000_000, what: "an xp award" }),
    radius: num(b.radius, r.at("radius"), { min: 0.05, max: 100, what: "a collision radius" }),
    height: num(b.height, r.at("height"), { min: 0.05, max: 100, what: "a standing height" }),
    aggro: num(b.aggro, r.at("aggro"), { min: 0, max: 500, what: "an aggro radius" }),
    variants,
    capture: opt(b.capture, r.at("capture"), readCapture),
    bond: opt(b.bond, r.at("bond"), bond),
    phases: opt(b.phases, r.at("phases"), list(readPhase, { min: 2, max: 8 })),
  };
}

/** `element` and `model` are NOT references — neither has an asset to resolve to. */
function* refs(_data: EnemyData): Iterable<ContentId> {}

function validate(asset: ContentAsset<EnemyData>, ctx: ValidateCtx): void {
  if (knownModels !== null && !knownModels.has(asset.data.model)) {
    ctx.report({
      severity: "error",
      code: "unknown-factory",
      message: `no "${ENEMY_MODEL_KIND}/${asset.data.model}" is registered`,
      field: "data.model",
      fix: `defineFactory("${ENEMY_MODEL_KIND}", "${asset.data.model}", …), or use one that exists`,
    });
  }
  // A capture block on a non-beast body is an orb that succeeds and grants nothing.
  if (asset.data.capture && !asset.data.model.startsWith(BEAST_MODEL_PREFIX)) {
    ctx.report({
      severity: "error",
      code: "bad-field",
      message: `"${asset.id}" can be bonded but wears "${asset.data.model}", which is not a beast's body`,
      field: "data.capture",
      fix: `give it a "${BEAST_MODEL_PREFIX}<species>" model, or drop the capture block`,
    });
  }
}

export const ENEMY_TYPE: ContentTypeDef<EnemyData> = {
  name: "enemy",
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: "enemy:new-beast",
    schema: 1,
    name: { text: { en: "New Beast" } },
    data: {
      model: "gloopling",
      flying: false,
      hp: 30,
      atk: 6,
      speed: 2.5,
      xp: 8,
      radius: 0.5,
      height: 1,
      aggro: 9,
      variants: [
        { element: "grass", main: "#ffffff", dark: "#888888", belly: "#cccccc", accent: "#000000" },
        { element: "grass", main: "#ffffff", dark: "#888888", belly: "#cccccc", accent: "#000000" },
        { element: "grass", main: "#ffffff", dark: "#888888", belly: "#cccccc", accent: "#000000" },
      ],
    },
  },
};
