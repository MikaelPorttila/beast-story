/**
 * PEOPLE AS CONTENT (spec §4.1) — the `NpcCharacter` record in
 * `src/world/npc-gain.ts`, minus its two functions.
 *
 * THE SPLIT IS ALREADY THERE AND THIS FOLLOWS IT. `world/npc.ts` is the generic
 * half — placement, culling, the interact test, the talk state — and a character
 * file is the other half. Of that character file, `build()` and `animate()` are
 * behaviour and stay in TypeScript: a voxel body and a dumbbell curl are code,
 * and only the CHOICE of them is data (`"body": "gain"`, the `npc-body` factory
 * kind). What is left — who he is, which town he stands in, how far out he wants
 * to be, and what he says — is content, and it is all here.
 *
 * `talk` IS THE QUEST SEAM, EXPRESSED AS DATA. The doc comment on
 * `NpcCharacter.talk()` says that today it returns one line and that tomorrow it
 * consults quest state and returns an offer or a turn-in instead, with nothing
 * outside the function changing shape. That "tomorrow" is an ORDERED LIST with a
 * `when` on each entry: the engine takes the first whose condition passes, which
 * is the same rule a dialogue tree, a barter table and a rumour pool all want,
 * and it is the shape a validator can read and an editor can render as rows.
 *
 * THE MIGRATED GAIN HAS EXACTLY ONE ENTRY AND NO `when`, so he says what he
 * always said, in the same language, on the same key. This is a migration: it
 * moves where a fact is written down and changes no fact. A second line belongs
 * in the commit that has a quest for it to be about.
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
} from '../schema';
import type { Reader } from '../schema';
import { isKnownTextKey } from '../text';

/** The factory kind an NPC's `body` selects. `npc-body/gain`. */
export const NPC_BODY_KIND = 'npc-body';

const BODY_RE = /^[a-z][a-z0-9-]*$/;

/**
 * One thing this character might say.
 *
 * ORDERED, AND FIRST MATCH WINS. That is what makes an entry with no `when` a
 * DEFAULT rather than an alternative, and it is why the list is a list and not a
 * set: "offer the quest if it is available, otherwise say hello" is a statement
 * about precedence, and precedence is order. An entry with no `when` after which
 * further entries appear is therefore unreachable, which `validate` says out
 * loud — it is the one authoring mistake this shape makes easy.
 */
export interface NpcTalkLine {
  /** Absent means "always", the same rule the envelope's `when` follows. */
  readonly when?: Condition;
  readonly line: ContentText;
  /**
   * What saying it DOES — set a flag, start a quest. Absent when it does
   * nothing, which is the common case and the only case in the shipped content.
   */
  readonly actions?: readonly Action[];
}

export interface NpcData {
  /** Which settlement he stands in — a REFERENCE, so it is in `refs()`. */
  readonly town: ContentId;
  /** Which registered `npc-body` builds and animates him. */
  readonly body: string;
  /**
   * How far from the town's centre he would LIKE to stand, in world units. The
   * placement search only ever pushes him further out, and only as far as it has
   * to to get him off the carriageway and out of the furniture.
   */
  readonly homeOffset: number;
  /**
   * Stand on the far side of the settlement's focus from wherever he would
   * otherwise have stood. Opt-in, because it only means anything in a settlement
   * that HAS a focus — the Encampment's fire.
   */
  readonly acrossFocus: boolean;
  readonly talk: readonly NpcTalkLine[];
}

/** Registered `npc-body` names. See the long note at `knownLayouts` in town.ts. */
let knownBodies: ReadonlySet<string> | null = null;

export function setKnownNpcBodies(names: Iterable<string>): void {
  knownBodies = new Set(names);
}

function readTalkLine(value: unknown, ctx: Reader): NpcTalkLine {
  if (!isRecord(value)) {
    ctx.report('error', 'bad-field', 'expected a talk entry object', 'write { "line": { "key": "…" } }');
    return { line: text(undefined, ctx.at('line')) };
  }
  const acts = readActions(value.actions, ctx.at('actions'));
  return {
    when: opt(value.when, ctx.at('when'), condition),
    line: text(value.line, ctx.at('line')),
    // Omitted rather than stored empty: "absence is the default, everywhere" is
    // the house rule (state.ts states it for the save), and an empty list here
    // would make `serialize` round-trip a field the author never wrote.
    ...(acts.length > 0 ? { actions: acts } : {}),
  };
}

function parse(body: unknown, ctx: ParseCtx): NpcData | null {
  const r = readerFor(ctx, { knownTextKey: isKnownTextKey });
  const b = obj(body, r);
  return {
    town: idOf('town')(b.town, r.at('town')),
    body: str(b.body, r.at('body'), { min: 1, max: 64, pattern: BODY_RE, what: 'an npc body name' }),
    homeOffset: opt(b.homeOffset, r.at('homeOffset'), (v, c) =>
      num(v, c, { min: 0, max: 500, what: 'a distance from the town centre' })) ?? 0,
    acrossFocus: opt(b.acrossFocus, r.at('acrossFocus'), bool) ?? false,
    talk: list(readTalkLine, { min: 1, max: 256 })(b.talk, r.at('talk')),
  };
}

function* refs(data: NpcData): Iterable<ContentId> {
  // The empty string is `idOf`'s fallback for a malformed id and can never
  // parse; the field it came from was already reported where it was read, so
  // yielding it would charge one typo a second diagnostic in a vocabulary the
  // author never used (validate.ts makes the same argument at `checkRefs`).
  if (data.town !== '') yield data.town;
}

function validate(asset: ContentAsset<NpcData>, ctx: ValidateCtx): void {
  if (knownBodies !== null && !knownBodies.has(asset.data.body)) {
    ctx.report({
      severity: 'error',
      code: 'unknown-factory',
      message: `no "${NPC_BODY_KIND}/${asset.data.body}" is registered`,
      field: 'data.body',
      fix: `defineFactory("${NPC_BODY_KIND}", "${asset.data.body}", …), or use one that exists`,
    });
  }

  // An unconditional line makes everything after it dead — see `NpcTalkLine`.
  // A warn rather than an error: the NPC works, he simply never says the rest,
  // and the fix is to reorder rather than to remove anything.
  const lines = asset.data.talk;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].when !== undefined) continue;
    ctx.report({
      severity: 'warn',
      code: 'never-available',
      message: `talk[${i}] has no "when", so the ${lines.length - i - 1} entries after it are unreachable`,
      field: `data.talk[${i}]`,
      fix: 'first match wins — put the unconditional line last',
    });
    break;
  }
}

export const NPC_TYPE: ContentTypeDef<NpcData> = {
  name: 'npc',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'npc:new-person',
    schema: 1,
    name: { text: { en: 'New Person' } },
    data: {
      town: 'town:encampment',
      body: 'gain',
      homeOffset: 4,
      acrossFocus: false,
      talk: [{ line: { text: { en: '…' } } }],
    },
  },
};
