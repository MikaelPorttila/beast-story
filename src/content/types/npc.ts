/** People as content: who an NPC is, where he stands and what he says. `build()`/`animate()` stay in code. */

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
  bool,
  condition,
  idOf,
  isRecord,
  list,
  num,
  obj,
  opt,
  readerFor,
  str,
  text,
} from "../schema";
import type { Reader } from "../schema";
import { isKnownTextKey } from "../text";

/** The factory kind an NPC's `body` selects. `npc-body/gain`. */
export const NPC_BODY_KIND = "npc-body";

const BODY_RE = /^[a-z][a-z0-9-]*$/;

/** One thing this character might say. ORDERED, first match wins. */
export interface NpcTalkLine {
  /** Absent means "always", the same rule the envelope's `when` follows. */
  readonly when?: Condition;
  readonly line: ContentText;
  /** What saying it DOES — set a flag, start a quest. */
  readonly actions?: readonly Action[];
}

export interface NpcData {
  /** Which settlement he stands in — a REFERENCE, so it is in `refs()`. */
  readonly town: ContentId;
  /** Which registered `npc-body` builds and animates him. */
  readonly body: string;
  /** Preferred distance from town centre, world units. Placement only pushes further out. */
  readonly homeOffset: number;
  /** Stand on the far side of the settlement's focus (the Encampment's fire). */
  readonly acrossFocus: boolean;
  /** Measure `homeOffset` from the settlement's focus rather than its centre — a ring AROUND the fire. */
  readonly atFocus: boolean;
  /**
   * WHEN he stands there at all — absent means always. Evaluated live, so a
   * character can arrive on a flag and leave on another (the Act 4 homecoming,
   * issue #162); a ground crew reconciles on every state change.
   */
  readonly present?: Condition;
  readonly talk: readonly NpcTalkLine[];
}

/** Registered `npc-body` names; null skips the check. See `knownLayouts` in town.ts. */
let knownBodies: ReadonlySet<string> | null = null;

export function setKnownNpcBodies(names: Iterable<string>): void {
  knownBodies = new Set(names);
}

function readTalkLine(value: unknown, ctx: Reader): NpcTalkLine {
  if (!isRecord(value)) {
    ctx.report(
      "error",
      "bad-field",
      "expected a talk entry object",
      'write { "line": { "key": "…" } }',
    );
    return { line: text(undefined, ctx.at("line")) };
  }
  const acts = readActions(value.actions, ctx.at("actions"));
  return {
    when: opt(value.when, ctx.at("when"), condition),
    line: text(value.line, ctx.at("line")),
    // Omitted rather than stored empty, so `serialize` never round-trips a field nobody wrote.
    ...(acts.length > 0 ? { actions: acts } : {}),
  };
}

function parse(body: unknown, ctx: ParseCtx): NpcData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);
  return {
    town: idOf("town")(b.town, r.at("town")),
    body: str(b.body, r.at("body"), {
      min: 1,
      max: 64,
      pattern: BODY_RE,
      what: "an npc body name",
    }),
    homeOffset:
      opt(b.homeOffset, r.at("homeOffset"), (v, c) =>
        num(v, c, { min: 0, max: 500, what: "a distance from the town centre" }),
      ) ?? 0,
    acrossFocus: opt(b.acrossFocus, r.at("acrossFocus"), bool) ?? false,
    atFocus: opt(b.atFocus, r.at("atFocus"), bool) ?? false,
    present: opt(b.present, r.at("present"), condition),
    talk: list(readTalkLine, { min: 1, max: 256 })(b.talk, r.at("talk")),
  };
}

function* refs(data: NpcData): Iterable<ContentId> {
  // '' is `idOf`'s fallback for a malformed id, already reported where it was read.
  if (data.town !== "") {
    yield data.town;
  }
}

function validate(asset: ContentAsset<NpcData>, ctx: ValidateCtx): void {
  if (knownBodies !== null && !knownBodies.has(asset.data.body)) {
    ctx.report({
      severity: "error",
      code: "unknown-factory",
      message: `no "${NPC_BODY_KIND}/${asset.data.body}" is registered`,
      field: "data.body",
      fix: `defineFactory("${NPC_BODY_KIND}", "${asset.data.body}", …), or use one that exists`,
    });
  }

  // An unconditional line makes everything after it dead. Warn: the fix is a reorder.
  const lines = asset.data.talk;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].when !== undefined) {
      continue;
    }
    ctx.report({
      severity: "warn",
      code: "never-available",
      message: `talk[${i}] has no "when", so the ${lines.length - i - 1} entries after it are unreachable`,
      field: `data.talk[${i}]`,
      fix: "first match wins — put the unconditional line last",
    });
    break;
  }
}

export const NPC_TYPE: ContentTypeDef<NpcData> = {
  name: "npc",
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: "npc:new-person",
    schema: 1,
    name: { text: { en: "New Person" } },
    data: {
      town: "town:encampment",
      body: "gain",
      homeOffset: 4,
      acrossFocus: false,
      atFocus: false,
      talk: [{ line: { text: { en: "…" } } }],
    },
  },
};
