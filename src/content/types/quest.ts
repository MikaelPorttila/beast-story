/**
 * QUESTS (spec §9) — the type that makes conditions and actions mean something.
 *
 * The world clock reads only `timeOfDay`; there is still no quest UI or journal.
 * The rest is the shape a quest has, so that `Condition`, `Action`,
 * `ContentState` and the reference graph have a subject. Every other
 * type here describes a thing that already exists in the world and is being
 * moved; this one describes the thing all of that machinery was built for, and
 * `data/example-quest.json` is the end-to-end proof that a package can arrive
 * later, reference content it did not ship with, and be unloaded again.
 *
 * PROGRESS IS TRACKED PER QUEST ID, AND NEVER AS A POSITION IN A LINE (spec
 * §9.3). This is the rule the whole content design was shaped around and it is
 * worth restating where a quest is defined rather than only where a save is
 * written. `mainQuestProgress = 7` means "seven quests into the line AS THE LINE
 * STOOD ON THE DAY THIS SAVE WAS WRITTEN": insert a quest into the middle and
 * every existing player moves backward, the same 7 now naming a different quest,
 * and no migration can fix it because the save never recorded what the player
 * actually did. So a quest's place in the story is `prerequisites` — a set of
 * ids — and `available`, a condition recomputed from the facts in
 * `ContentState`. Reorder the line, split it across packages, add to it a year
 * later from a remote pack: an old save keeps meaning what it meant. That is
 * also why `ContentState` holds `completedQuests` and flags and holds no
 * counter, and why `arc` below is a LABEL and carries no ordering.
 *
 * THE REWARDS FIELD IS COUNTS ONLY, AND THAT IS THE INTERESTING RESTRICTION.
 * Anything a reward DOES — unlock a skill, hand over a named item with
 * properties, open a gate — is an `onComplete` ACTION, because an action names a
 * registered handler and is therefore inspectable, validatable and bounded by
 * what the engine chose to expose (actions.ts). A free-form reward bag would be a
 * second, unchecked way for content to reach the game, which is the exact thing
 * §4.6 forbids. What is left is genuinely a table of amounts — xp, and the
 * currency by its item ID (`shard`, which is what the drop table and the save
 * key on, whatever it displays as) — so that is what it is typed as.
 */

import type {
  Action,
  Condition,
  ContentAsset,
  ContentId,
  ContentText,
  ContentTypeDef,
  ParseCtx,
  ValidateCtx,
} from '../types';
import {
  actions as readActions,
  condition,
  idOf,
  int,
  isRecord,
  list,
  num,
  obj,
  opt,
  readerFor,
  record,
  str,
  text,
} from '../schema';
import type { Reader } from '../schema';
import { isObjectiveName } from '../state';
import { isKnownTextKey } from '../text';

/**
 * The kinds of world fact the engine can see happen.
 *
 * ONE ENTRY PER FACT, NOT PER QUEST. The whole reason objectives carry a trigger
 * at all is that the alternative — a hook per quest in main.ts — makes every new
 * quest an engine change, and makes the taming trigger Act 1, Act 2 and Act 3 all
 * need three copies of one idea. Adding a KIND here is engine work (something
 * has to observe the fact and call the router); adding a quest that uses one is
 * not.
 */
export type ObjectiveTriggerKind =
  | 'orb-thrown'
  | 'tamed'
  | 'enemy-killed'
  | 'item-picked'
  | 'town-arrival'
  | 'zone-arrival';

const TRIGGER_KINDS: readonly ObjectiveTriggerKind[] = [
  'orb-thrown', 'tamed', 'enemy-killed', 'item-picked', 'town-arrival', 'zone-arrival',
];

/**
 * Which fact advances an objective, and which instances of it count.
 *
 * The filters are all OPTIONAL and all mean "any" when absent, so
 * `{ "kind": "tamed" }` is "bond anything" and
 * `{ "kind": "enemy-killed", "enemies": ["enemy:gloopling"] }` is a cull list.
 * An absent filter is the useful default in every case where the fact itself is
 * already the interesting part.
 */
export interface ObjectiveTrigger {
  readonly kind: ObjectiveTriggerKind;
  /** `enemy-killed`: which enemies count. Absent = any. */
  readonly enemies?: readonly ContentId[];
  /** `tamed`: which beast species count, by species id. Absent = any. */
  readonly species?: readonly string[];
  /** `item-picked`: the item id that counts. Absent = any. */
  readonly item?: string;
  /** `town-arrival`: which town. Absent = any. */
  readonly town?: ContentId;
  /** `zone-arrival`: the `ZoneDef` id — `overworld`, `hold`. Absent = any. */
  readonly zone?: string;
}

/**
 * One thing the player has to do.
 *
 * `key` is what `ContentState.progress(quest, key)` counts against, so it is an
 * IDENTIFIER and lives under the same rule every other identifier here does: it
 * is stored in a save, it never changes when the wording does, and it may not
 * contain `/` — the progress key is `questId + '/' + objective` split at its LAST
 * slash, and a quest id may itself carry slashes (`quest:encampment/first-steps`),
 * so one in the objective silently attributes a counter to the wrong quest.
 * `isObjectiveName` in state.ts is where that rule is spelled; this reads it
 * rather than restating the regex.
 *
 * NO TRIGGER MEANS "SOMETHING ELSE ADVANCES ME", not "impossible". A talk
 * objective is advanced by the `progress.add` in the dialogue row that says the
 * words, which is the seam that already existed and needed no engine to observe
 * it.
 */
export interface QuestObjective {
  readonly key: string;
  readonly text: ContentText;
  /** How many. Absent means one, i.e. a boolean-shaped objective. */
  readonly count?: number;
  /** What the engine watches for. Absent = advanced by `progress.add` only. */
  readonly trigger?: ObjectiveTrigger;
}

/** Amounts granted on completion. Keyed by what is granted — see the header. */
export type QuestRewards = Readonly<Record<string, number>>;

export interface QuestData {
  readonly category: 'main' | 'side';
  /**
   * A story grouping, for a journal that wants headings. A LABEL and not an
   * order: nothing may derive "which one is next" from it — see the header.
   */
  readonly arc?: string;
  /** Who offers it. */
  readonly giver?: ContentId;
  /** Where it happens, for a marker and for a journal line. */
  readonly location?: ContentId;
  /** Quests that must be `completed` first. Ids, never positions. */
  readonly prerequisites: readonly ContentId[];
  /**
   * When it may be offered, over and above the prerequisites.
   *
   * ABSENT MEANS ALWAYS, the same rule the envelope's `when` follows and for the
   * same reason: most content is ungated, and making every author write
   * `{"test":"always"}` is ceremony on the majority to serve the minority. A
   * MALFORMED one is `NEVER` (schema.ts) — the asymmetry is that hidden content
   * is a bug report and revealed content is a spoiler.
   */
  readonly available?: Condition;
  /**
   * While this quest is active, pin the world clock to this normalised phase.
   * Midnight is 0, dawn .25, noon .5 and dusk .75.
   */
  readonly timeOfDay?: number;
  readonly objectives: readonly QuestObjective[];
  readonly onStart?: readonly Action[];
  readonly onComplete?: readonly Action[];
  readonly rewards?: QuestRewards;
}

const category = (value: unknown, ctx: Reader): 'main' | 'side' => {
  const v = str(value, ctx, { min: 1, max: 32, what: 'a quest category', fallback: 'side' });
  if (v === 'main' || v === 'side') return v;
  ctx.report('error', 'bad-field', `expected "main" or "side", got "${v}"`);
  return 'side';
};

/**
 * A trigger, or `undefined` when it is malformed.
 *
 * A BROKEN TRIGGER DROPS TO "NO TRIGGER", which is this file's version of the
 * fail-closed rule the schema header states: the objective survives, is visible
 * in the journal, and simply does not tick — a quest the player can see and
 * cannot finish is a bug report, where an objective that vanished is a quest
 * that silently completes itself. The diagnostic names the field either way.
 */
function readTrigger(value: unknown, ctx: Reader): ObjectiveTrigger | undefined {
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    ctx.report('error', 'bad-field', 'expected a trigger object',
      'write { "kind": "enemy-killed", "enemies": ["enemy:gloopling"] }');
    return undefined;
  }
  const kind = str(v.kind, ctx.at('kind'), { min: 1, max: 32, what: 'a trigger kind' });
  const found = TRIGGER_KINDS.find((k) => k === kind);
  if (found === undefined) {
    ctx.at('kind').report(
      'error',
      'bad-field',
      `"${kind}" is not a trigger the engine watches for`,
      `one of ${TRIGGER_KINDS.join(', ')}`,
    );
    return undefined;
  }
  return {
    kind: found,
    enemies: opt(v.enemies, ctx.at('enemies'), list(idOf('enemy'), { max: 64 })),
    species: opt(v.species, ctx.at('species'), list(
      (s, c) => str(s, c, { min: 1, max: 64, what: 'a species id' }), { max: 64 })),
    item: opt(v.item, ctx.at('item'), (s, c) =>
      str(s, c, { min: 1, max: 64, what: 'an item id' })),
    town: opt(v.town, ctx.at('town'), idOf('town')),
    zone: opt(v.zone, ctx.at('zone'), (s, c) =>
      str(s, c, { min: 1, max: 64, what: 'a zone id' })),
  };
}

function readObjective(value: unknown, ctx: Reader): QuestObjective {
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    ctx.report('error', 'bad-field', 'expected an objective object',
      'write { "key": "talk-to-gain", "text": { "key": "…" } }');
  }
  const key = str(v.key, ctx.at('key'), { min: 1, max: 64, what: 'an objective key' });
  if (key !== '' && !isObjectiveName(key)) {
    ctx.at('key').report(
      'error',
      'bad-field',
      `"${key}" is not usable as an objective key`,
      'printable, no spaces, and no "/" — the progress key is "<quest>/<objective>"',
    );
  }
  return {
    key: isObjectiveName(key) ? key : '',
    text: text(v.text, ctx.at('text')),
    count: opt(v.count, ctx.at('count'), (n, c) =>
      int(n, c, { min: 1, max: 1_000_000, what: 'how many' })),
    trigger: opt(v.trigger, ctx.at('trigger'), readTrigger),
  };
}

function parse(body: unknown, ctx: ParseCtx): QuestData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);

  const onStart = readActions(b.onStart, r.at('onStart'));
  const onComplete = readActions(b.onComplete, r.at('onComplete'));
  let timeOfDay: number | undefined;
  if (b.timeOfDay !== undefined) {
    const v = b.timeOfDay;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1) {
      timeOfDay = v;
    } else {
      r.at('timeOfDay').report(
        'error',
        'bad-field',
        '`timeOfDay` must be a normalised number from 0 (inclusive) to 1 (exclusive)',
        'use 0 midnight, 0.25 dawn, 0.5 noon or 0.75 dusk',
      );
    }
  }

  return {
    category: category(b.category, r.at('category')),
    arc: opt(b.arc, r.at('arc'), (v, c) => str(v, c, { min: 1, max: 64, what: 'an arc name' })),
    giver: opt(b.giver, r.at('giver'), idOf('npc')),
    location: opt(b.location, r.at('location'), idOf('town')),
    prerequisites: opt(b.prerequisites, r.at('prerequisites'), list(idOf('quest'), { max: 64 })) ?? [],
    available: opt(b.available, r.at('available'), condition),
    ...(timeOfDay !== undefined ? { timeOfDay } : {}),
    objectives: list(readObjective, { min: 1, max: 64 })(b.objectives, r.at('objectives')),
    // Absence is the default: an empty list is omitted so `serialize` cannot
    // round-trip a field the author never wrote. Same rule as npc.ts's `actions`.
    ...(onStart.length > 0 ? { onStart } : {}),
    ...(onComplete.length > 0 ? { onComplete } : {}),
    rewards: opt(b.rewards, r.at('rewards'), record(
      (v, c) => num(v, c, { min: 0, max: 1_000_000, what: 'a reward amount' }),
      { key: /^[a-z][a-z0-9-]*$/, max: 32 },
    )),
  };
}

/**
 * Everything a quest points at: who gives it, where it is, what must be done
 * first, and what its objectives are watching for. Extracted rather than
 * authored, which is what makes "what breaks if I delete `npc:gain`" answerable
 * (types.ts, spec §4.3) — and an objective's cull list is exactly that question
 * about an enemy.
 */
function* refs(data: QuestData): Iterable<ContentId> {
  // The empty string is `idOf`'s fallback and can never parse — already reported
  // at the field it came from.
  if (data.giver !== undefined && data.giver !== '') yield data.giver;
  if (data.location !== undefined && data.location !== '') yield data.location;
  for (const id of data.prerequisites) if (id !== '') yield id;
  for (const o of data.objectives) {
    const trigger = o.trigger;
    if (!trigger) continue;
    if (trigger.town !== undefined && trigger.town !== '') yield trigger.town;
    for (const id of trigger.enemies ?? []) if (id !== '') yield id;
  }
}

function validate(asset: ContentAsset<QuestData>, ctx: ValidateCtx): void {
  // A quest that requires itself can never start, and the central reference
  // check cannot see it: the id resolves perfectly — to this asset.
  if (asset.data.prerequisites.includes(asset.id)) {
    ctx.report({
      severity: 'error',
      code: 'never-available',
      message: 'lists itself as a prerequisite, so it can never become available',
      field: 'data.prerequisites',
      fix: 'remove it — a prerequisite is a quest that must be completed FIRST',
    });
  }

  // Two objectives with one key share a progress counter, which reads as one of
  // them completing itself the moment the other advances.
  const seen = new Set<string>();
  asset.data.objectives.forEach((objective, i) => {
    if (objective.key === '' || !seen.has(objective.key)) {
      seen.add(objective.key);
      return;
    }
    ctx.report({
      severity: 'error',
      code: 'bad-field',
      message: `two objectives share the key "${objective.key}"`,
      field: `data.objectives[${i}].key`,
      fix: 'progress is stored per "<quest>/<objective>", so the two would count as one',
    });
  });
}

export const QUEST_TYPE: ContentTypeDef<QuestData> = {
  name: 'quest',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'quest:new-quest',
    schema: 1,
    name: { text: { en: 'New Quest' } },
    data: {
      category: 'side',
      prerequisites: [],
      objectives: [{ key: 'do-the-thing', text: { text: { en: 'Do the thing' } } }],
    },
  },
};
