/**
 * Quests. Progress is tracked per quest ID, never as a position in a line, so a
 * quest's place in the story is `prerequisites` + `available` and `arc` is a label
 * with no ordering. `rewards` is counts only — anything a reward DOES is an action.
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
} from "../types";
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
} from "../schema";
import type { Reader } from "../schema";
import { isObjectiveName } from "../state";
import { isKnownTextKey } from "../text";

/** One entry per FACT, not per quest — adding a kind is engine work, using one is not. */
export type ObjectiveTriggerKind =
  | "orb-thrown"
  | "tamed"
  | "enemy-killed"
  | "item-picked"
  | "town-arrival"
  | "zone-arrival"
  | "escort"
  | "ride";

const TRIGGER_KINDS: readonly ObjectiveTriggerKind[] = [
  "orb-thrown",
  "tamed",
  "enemy-killed",
  "item-picked",
  "town-arrival",
  "zone-arrival",
  "escort",
  "ride",
];

/**
 * Which fact advances an objective, and which instances count. Every filter is
 * "any" when absent, and constrains only the kind it names — on any other kind it
 * just says what the objective is ABOUT, which is what world markers point at.
 */
export interface ObjectiveTrigger {
  readonly kind: ObjectiveTriggerKind;
  readonly enemies?: readonly ContentId[];
  readonly species?: readonly string[];
  readonly item?: string;
  readonly town?: ContentId;
  /** The `ZoneDef` id — `overworld`, `hold`. */
  readonly zone?: string;
  /** On `escort`: WHO is walked. The `escort.start` action names the same id. */
  readonly npc?: ContentId;
  /**
   * A STAGED SITE the engine derives and content cannot place — the wreck, the
   * reef ring (the `site` field the questWaypoint note in main.ts priced in).
   * On `escort` it is the destination; a name the engine does not implement is
   * a diagnostic at escort start. On `ride` it is the pad boarded FROM.
   */
  readonly site?: string;
}

/**
 * `key` is a saved IDENTIFIER and may not contain `/`: the progress key is
 * `questId + '/' + objective` split at its LAST slash, and quest ids carry slashes.
 */
export interface QuestObjective {
  readonly key: string;
  readonly text: ContentText;
  /** Absent means one, i.e. a boolean-shaped objective. */
  readonly count?: number;
  /** Absent = advanced by `progress.add` only. */
  readonly trigger?: ObjectiveTrigger;
}

/** Amounts granted on completion, keyed by what is granted (`xp`, an item id). */
export type QuestRewards = Readonly<Record<string, number>>;

export interface QuestData {
  readonly category: "main" | "side";
  /** A journal heading. A LABEL, never an order — nothing derives "next" from it. */
  readonly arc?: string;
  readonly giver?: ContentId;
  /** Who CLOSES it, when that is not who offered it — a quest can end where it sent you. */
  readonly turnIn?: ContentId;
  readonly location?: ContentId;
  readonly prerequisites: readonly ContentId[];
  /** Absent means always; a MALFORMED one is NEVER — revealed content is a spoiler. */
  readonly available?: Condition;
  /** Pins the world clock while active. Midnight 0, dawn .25, noon .5, dusk .75. */
  readonly timeOfDay?: number;
  readonly objectives: readonly QuestObjective[];
  readonly onStart?: readonly Action[];
  readonly onComplete?: readonly Action[];
  readonly rewards?: QuestRewards;
}

const category = (value: unknown, ctx: Reader): "main" | "side" => {
  const v = str(value, ctx, { min: 1, max: 32, what: "a quest category", fallback: "side" });
  if (v === "main" || v === "side") {
    return v;
  }
  ctx.report("error", "bad-field", `expected "main" or "side", got "${v}"`);
  return "side";
};

/** A broken trigger drops to "no trigger": the objective never ticks, rather than self-completing. */
function readTrigger(value: unknown, ctx: Reader): ObjectiveTrigger | undefined {
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      "expected a trigger object",
      'write { "kind": "enemy-killed", "enemies": ["enemy:gloopling"] }',
    );
    return undefined;
  }
  const kind = str(v.kind, ctx.at("kind"), { min: 1, max: 32, what: "a trigger kind" });
  const found = TRIGGER_KINDS.find((k) => k === kind);
  if (found === undefined) {
    ctx
      .at("kind")
      .report(
        "error",
        "bad-field",
        `"${kind}" is not a trigger the engine watches for`,
        `one of ${TRIGGER_KINDS.join(", ")}`,
      );
    return undefined;
  }
  return {
    kind: found,
    enemies: opt(v.enemies, ctx.at("enemies"), list(idOf("enemy"), { max: 64 })),
    species: opt(
      v.species,
      ctx.at("species"),
      list((s, c) => str(s, c, { min: 1, max: 64, what: "a species id" }), { max: 64 }),
    ),
    item: opt(v.item, ctx.at("item"), (s, c) => str(s, c, { min: 1, max: 64, what: "an item id" })),
    town: opt(v.town, ctx.at("town"), idOf("town")),
    zone: opt(v.zone, ctx.at("zone"), (s, c) => str(s, c, { min: 1, max: 64, what: "a zone id" })),
    npc: opt(v.npc, ctx.at("npc"), idOf("npc")),
    site: opt(v.site, ctx.at("site"), (s, c) => str(s, c, { min: 1, max: 64, what: "a site name" })),
  };
}

function readObjective(value: unknown, ctx: Reader): QuestObjective {
  const v: Record<string, unknown> = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      "expected an objective object",
      'write { "key": "talk-to-gain", "text": { "key": "…" } }',
    );
  }
  const key = str(v.key, ctx.at("key"), { min: 1, max: 64, what: "an objective key" });
  if (key !== "" && !isObjectiveName(key)) {
    ctx
      .at("key")
      .report(
        "error",
        "bad-field",
        `"${key}" is not usable as an objective key`,
        'printable, no spaces, and no "/" — the progress key is "<quest>/<objective>"',
      );
  }
  return {
    key: isObjectiveName(key) ? key : "",
    text: text(v.text, ctx.at("text")),
    count: opt(v.count, ctx.at("count"), (n, c) =>
      int(n, c, { min: 1, max: 1_000_000, what: "how many" }),
    ),
    trigger: opt(v.trigger, ctx.at("trigger"), readTrigger),
  };
}

function parse(body: unknown, ctx: ParseCtx): QuestData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);

  const onStart = readActions(b.onStart, r.at("onStart"));
  const onComplete = readActions(b.onComplete, r.at("onComplete"));
  let timeOfDay: number | undefined;
  if (b.timeOfDay !== undefined) {
    const v = b.timeOfDay;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1) {
      timeOfDay = v;
    } else {
      r.at("timeOfDay").report(
        "error",
        "bad-field",
        "`timeOfDay` must be a normalised number from 0 (inclusive) to 1 (exclusive)",
        "use 0 midnight, 0.25 dawn, 0.5 noon or 0.75 dusk",
      );
    }
  }

  return {
    category: category(b.category, r.at("category")),
    arc: opt(b.arc, r.at("arc"), (v, c) => str(v, c, { min: 1, max: 64, what: "an arc name" })),
    giver: opt(b.giver, r.at("giver"), idOf("npc")),
    turnIn: opt(b.turnIn, r.at("turnIn"), idOf("npc")),
    location: opt(b.location, r.at("location"), idOf("town")),
    prerequisites:
      opt(b.prerequisites, r.at("prerequisites"), list(idOf("quest"), { max: 64 })) ?? [],
    available: opt(b.available, r.at("available"), condition),
    ...(timeOfDay !== undefined ? { timeOfDay } : {}),
    objectives: list(readObjective, { min: 1, max: 64 })(b.objectives, r.at("objectives")),
    // Empty lists omitted so `serialize` cannot round-trip a field nobody wrote.
    ...(onStart.length > 0 ? { onStart } : {}),
    ...(onComplete.length > 0 ? { onComplete } : {}),
    rewards: opt(
      b.rewards,
      r.at("rewards"),
      record((v, c) => num(v, c, { min: 0, max: 1_000_000, what: "a reward amount" }), {
        key: /^[a-z][a-z0-9-]*$/,
        max: 32,
      }),
    ),
  };
}

function* refs(data: QuestData): Iterable<ContentId> {
  // '' is `idOf`'s fallback, already reported at the field it came from.
  if (data.giver !== undefined && data.giver !== "") {
    yield data.giver;
  }
  if (data.turnIn !== undefined && data.turnIn !== "") {
    yield data.turnIn;
  }
  if (data.location !== undefined && data.location !== "") {
    yield data.location;
  }
  for (const id of data.prerequisites) {
    if (id !== "") {
      yield id;
    }
  }
  for (const o of data.objectives) {
    const trigger = o.trigger;
    if (!trigger) {
      continue;
    }
    if (trigger.town !== undefined && trigger.town !== "") {
      yield trigger.town;
    }
    if (trigger.npc !== undefined && trigger.npc !== "") {
      yield trigger.npc;
    }
    for (const id of trigger.enemies ?? []) {
      if (id !== "") {
        yield id;
      }
    }
  }
}

function validate(asset: ContentAsset<QuestData>, ctx: ValidateCtx): void {
  // The central ref check cannot see this: the id resolves perfectly, to this asset.
  if (asset.data.prerequisites.includes(asset.id)) {
    ctx.report({
      severity: "error",
      code: "never-available",
      message: "lists itself as a prerequisite, so it can never become available",
      field: "data.prerequisites",
      fix: "remove it — a prerequisite is a quest that must be completed FIRST",
    });
  }

  // Two objectives with one key share a progress counter.
  const seen = new Set<string>();
  asset.data.objectives.forEach((objective, i) => {
    if (objective.key === "" || !seen.has(objective.key)) {
      seen.add(objective.key);
      return;
    }
    ctx.report({
      severity: "error",
      code: "bad-field",
      message: `two objectives share the key "${objective.key}"`,
      field: `data.objectives[${i}].key`,
      fix: 'progress is stored per "<quest>/<objective>", so the two would count as one',
    });
  });
}

export const QUEST_TYPE: ContentTypeDef<QuestData> = {
  name: "quest",
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: "quest:new-quest",
    schema: 1,
    name: { text: { en: "New Quest" } },
    data: {
      category: "side",
      prerequisites: [],
      objectives: [{ key: "do-the-thing", text: { text: { en: "Do the thing" } } }],
    },
  },
};
