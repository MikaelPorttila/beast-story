/**
 * WHAT THE PLAYER HAS DONE — the save boundary (spec §8.2, §9.3, §20).
 *
 * THE SAVE STORES FACTS AS IDS, NEVER A POSITION IN A LIST. That single rule is
 * the whole design and everything else here follows from it. `mainQuestProgress
 * = 7` is exactly what it exists to prevent: a number like that means "seven
 * quests into the line as the line stood on the day this save was written", so
 * inserting a quest into the middle of that line moves every existing player
 * BACKWARD — the same 7 now points at a different quest, and whether it reads as
 * a repeat, a skip or a soft-lock depends on which quest was inserted. There is
 * no migration that fixes it, because the save does not record enough to know
 * what the player actually did.
 *
 * Stored as ids, the question never comes up. The save says `quest:first-steps`
 * is completed and `met-gain` is set; AVAILABILITY IS RECOMPUTED from those
 * facts against whatever content is loaded today, so a quest inserted into the
 * line is simply a quest whose `when` is or is not satisfied by the facts the
 * player already has. Content can be reordered, split across packages, renamed
 * in its display text, or delivered by a remote pack a year later, and an old
 * save keeps meaning what it meant. Renaming an ID is the one thing that is a
 * migration rather than an edit, which is why ids.ts makes them narrow and
 * content/types.ts makes them stable.
 *
 * THE STORE HOLDS NO CONTENT AND CANNOT ASK ANY QUESTIONS ABOUT IT. It never
 * imports the registry, never looks an asset up and never validates a quest id
 * against loaded content — a fact about a quest from a package that is not
 * loaded right now is still a fact, and dropping it on load because the pack was
 * absent would silently erase a player's progress in a zone they were not
 * standing in. Whether an id means anything is the loader's and the validator's
 * question.
 *
 * VALIDATE ON READ — the house rule from core/prefs.ts, and it carries over
 * whole. A save is user-writable text (a hand edit, a half-completed write, a
 * value from a future build), so every field is checked as it comes IN and
 * anything unusable is dropped rather than trusted: a `NaN` counter propagates
 * silently through every `atLeast` comparison downstream and reads as a quest
 * that can never be finished. The shape that differs from prefs is deliberate:
 * this is a save-game PAYLOAD, one document written and read as a unit, so it is
 * one JSON object rather than prefs' key per setting — there is no second tab
 * editing half of it, and no devtools glance that wants one fact on its own.
 *
 * ABSENCE IS THE DEFAULT, EVERYWHERE. `setFlag(name, false)` DELETES rather than
 * storing `false`, a quest at `'unknown'` is a quest with no entry, and progress
 * 0 is no counter. So the save records what HAPPENED, and its size tracks the
 * story rather than the schema: a fresh profile is `{"v":1}` and not a page of
 * falses, and a flag that ships next month costs an old save nothing. It also
 * removes a whole class of disagreement — there is no way to store `false` and
 * `absent` and have two readers treat them differently.
 */

import type { ContentId, ContentState, QuestStatus, StateChange } from './types';
import { isId } from './ids';

/**
 * The payload revision. THE MIGRATION SEAM IS `migrateSave` BELOW: bump this,
 * add a branch there, and every load of an older save passes through it exactly
 * once on its way in. Nothing else in the file may read a version number — a
 * second place that switches on it is how two readers start disagreeing about
 * what version 2 meant.
 */
export const CONTENT_SAVE_VERSION = 1;

/**
 * Top-level keys this build understands. Everything else in a loaded save is
 * PRESERVED verbatim (spec §15.2) — see `fromJSON`.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'v',
  'flags',
  'quests',
  'progress',
  'discovered',
]);

const QUEST_STATUSES: ReadonlySet<string> = new Set<QuestStatus>([
  'unknown',
  'available',
  'active',
  'completed',
  'failed',
]);

export function isQuestStatus(value: unknown): value is QuestStatus {
  return typeof value === 'string' && QUEST_STATUSES.has(value);
}

/**
 * A flag name is FREE-FORM, and deliberately not held to the id grammar.
 *
 * A flag is not a reference to anything — nothing resolves it, so the reasons
 * ids.ts is narrow (file names, URLs, case-folding filesystems) do not apply.
 * What does apply is that it lands in a save, in a diagnostic and in a log line,
 * so the rules are only the ones that keep it readable there: non-empty,
 * bounded, and printable ASCII with no spaces — which excludes whitespace, the
 * control characters that would cut a log line in half, and the invisible
 * look-alikes that make two flags that read the same behave differently.
 * Anything else is rejected at the door rather than written into a save that a
 * later build would have to keep forever.
 */
const MAX_NAME_LEN = 128;
const BAD_NAME_RE = /[^\x21-\x7e]/;

export function isFlagName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NAME_LEN &&
    !BAD_NAME_RE.test(value)
  );
}

/**
 * An objective name may not contain `/`, and THAT IS WHAT MAKES THE COMPOSITE
 * KEY UNAMBIGUOUS. Progress is keyed `questId + '/' + objective`, and a quest id
 * may itself contain slashes (`quest:encampment/first-steps`), so the key is
 * split at its LAST slash on the way back in. Allow one in the objective and
 * that split silently attributes a counter to the wrong quest.
 */
export function isObjectiveName(value: unknown): value is string {
  return isFlagName(value) && !value.includes('/');
}

/** The one place the composite progress key is spelled. */
export function progressKey(quest: ContentId, objective: string): string {
  return `${quest}/${objective}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upgrade a save written against an older payload version.
 *
 * Nothing shipped before version 1, so today this is a seam and not a
 * transformation. Two properties it must keep when it stops being empty: it is
 * applied ONCE, on the way in, so the rest of the store only ever sees the
 * current shape; and a version NEWER than this build is passed through
 * untouched rather than rejected — the field-by-field reads below drop what they
 * cannot use and `fromJSON` preserves the rest, which between them is the
 * best an old build can honestly do with a new save.
 */
function migrateSave(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  if (from >= CONTENT_SAVE_VERSION) return raw;
  // v0 is "a save with no `v` at all" — nothing ever wrote one, so there is
  // nothing to move. A future v1 -> v2 branch goes here.
  return raw;
}

export class ContentStateStore implements ContentState {
  private readonly _flags = new Set<string>();
  /** Only non-`unknown` statuses are held; absence IS `'unknown'`. */
  private readonly _quests = new Map<ContentId, QuestStatus>();
  /** Keyed by `progressKey`. Absence IS 0. */
  private readonly _progress = new Map<string, number>();
  private readonly _discovered = new Set<ContentId>();
  /** Top-level save fields this build did not recognise. See `fromJSON`. */
  private _extra: Record<string, unknown> = {};
  private readonly _listeners: Array<(what: StateChange) => void> = [];

  // -------------------------------------------------------------------------
  // Flags
  // -------------------------------------------------------------------------

  flag(name: string): boolean {
    return this._flags.has(name);
  }

  setFlag(name: string, on: boolean): void {
    if (!isFlagName(name)) return;
    const had = this._flags.has(name);
    if (had === on) return;   // no-op: see `notify`
    if (on) this._flags.add(name);
    else this._flags.delete(name);   // cleared is ABSENT, never stored `false`
    this.notify('flag', name);
  }

  /**
   * Sorted, and a fresh array each read — this is for the save, the debug hook
   * and diagnostics, none of which run per frame. A condition asks `flag(name)`,
   * which is a Set hit and allocates nothing.
   */
  get flags(): readonly string[] {
    return [...this._flags].sort();
  }

  // -------------------------------------------------------------------------
  // Quests
  // -------------------------------------------------------------------------

  questStatus(id: ContentId): QuestStatus {
    return this._quests.get(id) ?? 'unknown';
  }

  setQuestStatus(id: ContentId, status: QuestStatus): void {
    if (!isId(id) || !isQuestStatus(status)) return;
    if (this.questStatus(id) === status) return;
    if (status === 'unknown') this._quests.delete(id);
    else this._quests.set(id, status);
    this.notify('quest', id);
  }

  /**
   * The active and completed lists are DERIVED from the one status map rather
   * than kept beside it. Two containers holding the same fact is two containers
   * that disagree the first time a status changes on a path that forgot one of
   * them — and "the quest log shows it active and the availability check says
   * completed" is a bug that only reproduces for the player it happened to.
   */
  get activeQuests(): readonly ContentId[] {
    return this.questsWith('active');
  }

  get completedQuests(): readonly ContentId[] {
    return this.questsWith('completed');
  }

  private questsWith(status: QuestStatus): ContentId[] {
    const out: ContentId[] = [];
    for (const [id, s] of this._quests) if (s === status) out.push(id);
    return out.sort();
  }

  // -------------------------------------------------------------------------
  // Objective progress
  // -------------------------------------------------------------------------

  progress(quest: ContentId, objective: string): number {
    return this._progress.get(progressKey(quest, objective)) ?? 0;
  }

  setProgress(quest: ContentId, objective: string, n: number): void {
    if (!isId(quest) || !isObjectiveName(objective) || !Number.isFinite(n)) return;
    // A counter is a count of things that happened, so it has a floor of 0 and
    // no ceiling the store could know — a "kill 5" objective is content's rule,
    // and clamping here would quietly hide an over-count instead of letting the
    // quest's own condition read it.
    const value = Math.max(0, n);
    const key = progressKey(quest, objective);
    if (this.progress(quest, objective) === value) return;
    if (value === 0) this._progress.delete(key);   // 0 is ABSENT
    else this._progress.set(key, value);
    this.notify('progress', key);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  discovered(id: ContentId): boolean {
    return this._discovered.has(id);
  }

  discover(id: ContentId): void {
    if (!isId(id) || this._discovered.has(id)) return;
    this._discovered.add(id);
    this.notify('discovery', id);
  }

  // -------------------------------------------------------------------------
  // Change notification
  // -------------------------------------------------------------------------

  onChange(fn: (what: StateChange) => void): () => void {
    this._listeners.push(fn);
    let live = true;
    return () => {
      if (!live) return;   // idempotent: a second call must not evict a later listener
      live = false;
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /**
   * ONE NOTIFICATION PER REAL CHANGE, AND NONE AT ALL FOR A NO-OP.
   *
   * Every mutator above returns early when the value it was handed is what is
   * already stored. That is not micro-optimisation: a listener's job here is to
   * re-evaluate availability across the whole content graph, so a notification
   * is expensive by construction, and setting a flag that is already set is the
   * single most common thing a re-entered dialogue or a re-triggered zone
   * volume does. Firing on it makes every listener recompute everything for a
   * state that did not move.
   *
   * The snapshot copy is the deliberate allocation in this file: a listener may
   * unsubscribe or mutate state from inside its own callback, and iterating the
   * live array while it is spliced skips whoever moved down into the gap.
   * Affordable precisely because this path is a story event and not a frame.
   */
  private notify(kind: StateChange['kind'], name: string): void {
    if (this._listeners.length === 0) return;
    const change: StateChange = { kind, name };
    for (const fn of this._listeners.slice()) fn(change);
  }

  // -------------------------------------------------------------------------
  // Save and load
  // -------------------------------------------------------------------------

  /**
   * The save payload. Plain JSON, no class instances, no `undefined`.
   *
   * DETERMINISTIC BY CONSTRUCTION: every array is sorted and every object's keys
   * are inserted in sorted order, which `JSON.stringify` preserves for string
   * keys. So two stores holding the same facts stringify to byte-identical text
   * and a test can assert on the diff — where an insertion-ordered dump differs
   * with the ORDER the player did things in, which is exactly the noise that
   * makes a save comparison useless.
   *
   * Empty collections are omitted rather than emitted empty, for the same reason
   * a cleared flag is deleted: the save is a record of what happened.
   */
  toJSON(): unknown {
    const out: Record<string, unknown> = { v: CONTENT_SAVE_VERSION };
    if (this._flags.size > 0) out.flags = this.flags;
    if (this._quests.size > 0) {
      const quests: Record<string, string> = {};
      for (const id of [...this._quests.keys()].sort()) quests[id] = this._quests.get(id) as string;
      out.quests = quests;
    }
    if (this._progress.size > 0) {
      const progress: Record<string, number> = {};
      for (const key of [...this._progress.keys()].sort()) {
        progress[key] = this._progress.get(key) as number;
      }
      out.progress = progress;
    }
    if (this._discovered.size > 0) out.discovered = [...this._discovered].sort();
    // Fields a newer build wrote, carried through last so they can never shadow
    // one of ours (they were filtered against KNOWN_FIELDS on the way in).
    for (const key of Object.keys(this._extra).sort()) out[key] = this._extra[key];
    return out;
  }

  /**
   * Replace everything from a save.
   *
   * EVERY FIELD IS VALIDATED AS IT IS READ and anything unusable is DROPPED —
   * a quest id that is not an id, a status this build has never heard of, a
   * counter that is a string. Dropping rather than throwing is the point: one
   * corrupt entry in a save costs the player that entry, where a throw out of a
   * load costs them the save.
   *
   * UNKNOWN TOP-LEVEL FIELDS ARE PRESERVED (spec §15.2). A player who runs a
   * newer build, earns something it records in a field this one has never seen,
   * and then opens this build must not have it silently deleted on the next
   * save — which is precisely what a `toJSON` that only emits what it knows
   * about would do. So they are held verbatim and written back out. Note the
   * limit of that promise: it is per TOP-LEVEL FIELD, so a new STATUS inside
   * `quests` is still dropped by the validation above. Widening a known field's
   * value space is a version bump and a `migrateSave` branch.
   */
  fromJSON(value: unknown): void {
    this.clear();
    if (isRecord(value)) {
      const version = typeof value.v === 'number' && Number.isFinite(value.v) ? value.v : 0;
      const raw = migrateSave(value, version);

      const flags = raw.flags;
      if (Array.isArray(flags)) {
        for (const f of flags) if (isFlagName(f)) this._flags.add(f);
      }

      const quests = raw.quests;
      if (isRecord(quests)) {
        for (const id of Object.keys(quests)) {
          const status = quests[id];
          // `unknown` is the absence of an entry, so a save that spells it out
          // (an older writer, a hand edit) normalises to nothing stored.
          if (isId(id) && isQuestStatus(status) && status !== 'unknown') {
            this._quests.set(id, status);
          }
        }
      }

      const progress = raw.progress;
      if (isRecord(progress)) {
        for (const key of Object.keys(progress)) {
          const n = progress[key];
          if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
          const cut = key.lastIndexOf('/');   // the LAST slash: quest names carry their own
          if (cut <= 0) continue;
          if (!isId(key.slice(0, cut)) || !isObjectiveName(key.slice(cut + 1))) continue;
          this._progress.set(key, n);
        }
      }

      const discovered = raw.discovered;
      if (Array.isArray(discovered)) {
        for (const id of discovered) if (isId(id)) this._discovered.add(id);
      }

      for (const key of Object.keys(raw)) {
        if (!KNOWN_FIELDS.has(key)) this._extra[key] = raw[key];
      }
    }
    // Fires even when the save was garbage and nothing was read: the store's
    // contents changed regardless (they were cleared), and a listener holding
    // a derived view must drop it.
    this.notify('reset', 'load');
  }

  /**
   * Back to a fresh profile — what Exit to title does.
   *
   * This is the one mutation that notifies UNCONDITIONALLY, including when the
   * store was already empty. `reset` is a session boundary rather than a value
   * change: a listener caching availability across a New Game has to be told the
   * session ended, and "nothing to clear" is not a reason to leave it holding
   * the last session's derived state.
   */
  reset(): void {
    this.clear();
    this.notify('reset', 'reset');
  }

  private clear(): void {
    this._flags.clear();
    this._quests.clear();
    this._progress.clear();
    this._discovered.clear();
    this._extra = {};
  }
}
