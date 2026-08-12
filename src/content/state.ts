// The save boundary. Facts are stored as IDS, never as a position in a list, so
// availability is recomputed and reordering content cannot move an old save.
// Renaming an id is a migration, not an edit.
// The store holds NO content and never checks an id against the registry — a fact
// about an unloaded package is still a fact.
// Validate on read (as core/prefs.ts does); absence is the default everywhere.

import type { ContentId, ContentState, QuestStatus, StateChange } from "./types";
import { isId } from "./ids";

// Bump this and add a branch to `migrateSave`. Nothing else may read the version.
export const CONTENT_SAVE_VERSION = 1;

/** Everything else in a loaded save is preserved verbatim — see `fromJSON`. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "v",
  "flags",
  "quests",
  "progress",
  "discovered",
]);

const QUEST_STATUSES: ReadonlySet<string> = new Set<QuestStatus>([
  "unknown",
  "available",
  "active",
  "completed",
  "failed",
]);

export function isQuestStatus(value: unknown): value is QuestStatus {
  return typeof value === "string" && QUEST_STATUSES.has(value);
}

// A flag resolves to nothing, so it is free-form — but printable ASCII, no spaces,
// bounded, since it lands in saves and log lines.
const MAX_NAME_LEN = 128;
const BAD_NAME_RE = /[^\x21-\x7e]/;

export function isFlagName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LEN &&
    !BAD_NAME_RE.test(value)
  );
}

// No `/`: progress keys are `questId/objective` and a quest id may hold slashes of
// its own, so the key is split at its LAST slash.
export function isObjectiveName(value: unknown): value is string {
  return isFlagName(value) && !value.includes("/");
}

/** The one place the composite progress key is spelled. */
export function progressKey(quest: ContentId, objective: string): string {
  return `${quest}/${objective}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Applied ONCE on the way in, so the store only sees the current shape. A NEWER
// version passes through untouched rather than being rejected.
function migrateSave(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  if (from >= CONTENT_SAVE_VERSION) {
    return raw;
  }
  // A future v1 -> v2 branch goes here.
  return raw;
}

export class ContentStateStore implements ContentState {
  private readonly _flags = new Set<string>();
  /** Only non-`unknown` statuses are held; absence IS `'unknown'`. */
  private readonly _quests = new Map<ContentId, QuestStatus>();
  /** Keyed by `progressKey`. Absence IS 0. */
  private readonly _progress = new Map<string, number>();
  private readonly _discovered = new Set<ContentId>();
  /** Unrecognised top-level save fields. See `fromJSON`. */
  private _extra: Record<string, unknown> = {};
  private readonly _listeners: Array<(what: StateChange) => void> = [];

  flag(name: string): boolean {
    return this._flags.has(name);
  }

  setFlag(name: string, on: boolean): void {
    if (!isFlagName(name)) {
      return;
    }
    const had = this._flags.has(name);
    if (had === on) {
      return;
    }
    if (on) {
      this._flags.add(name);
    } else {
      this._flags.delete(name);
    } // cleared is ABSENT, never stored `false`
    this.notify("flag", name);
  }

  /** Fresh array each read; not a frame path — conditions use `flag(name)`. */
  get flags(): readonly string[] {
    return [...this._flags].toSorted();
  }

  questStatus(id: ContentId): QuestStatus {
    return this._quests.get(id) ?? "unknown";
  }

  setQuestStatus(id: ContentId, status: QuestStatus): void {
    if (!isId(id) || !isQuestStatus(status)) {
      return;
    }
    if (this.questStatus(id) === status) {
      return;
    }
    if (status === "unknown") {
      this._quests.delete(id);
    } else {
      this._quests.set(id, status);
    }
    this.notify("quest", id);
  }

  // Derived from the status map, never kept beside it — two copies would disagree.
  get activeQuests(): readonly ContentId[] {
    return this.questsWith("active");
  }

  get completedQuests(): readonly ContentId[] {
    return this.questsWith("completed");
  }

  private questsWith(status: QuestStatus): ContentId[] {
    const out: ContentId[] = [];
    for (const [id, s] of this._quests) {
      if (s === status) {
        out.push(id);
      }
    }
    return out.toSorted();
  }

  progress(quest: ContentId, objective: string): number {
    return this._progress.get(progressKey(quest, objective)) ?? 0;
  }

  setProgress(quest: ContentId, objective: string, n: number): void {
    if (!isId(quest) || !isObjectiveName(objective) || !Number.isFinite(n)) {
      return;
    }
    // Floor 0, no ceiling: a target is content's rule, and clamping would hide
    // an over-count from the quest's own condition.
    const value = Math.max(0, n);
    const key = progressKey(quest, objective);
    if (this.progress(quest, objective) === value) {
      return;
    }
    if (value === 0) {
      this._progress.delete(key);
    } // 0 is ABSENT
    else {
      this._progress.set(key, value);
    }
    this.notify("progress", key);
  }

  discovered(id: ContentId): boolean {
    return this._discovered.has(id);
  }

  discover(id: ContentId): void {
    if (!isId(id) || this._discovered.has(id)) {
      return;
    }
    this._discovered.add(id);
    this.notify("discovery", id);
  }

  onChange(fn: (what: StateChange) => void): () => void {
    this._listeners.push(fn);
    let live = true;
    return () => {
      if (!live) {
        return;
      } // idempotent: a second call must not evict a later listener
      live = false;
      const i = this._listeners.indexOf(fn);
      if (i >= 0) {
        this._listeners.splice(i, 1);
      }
    };
  }

  // One notification per real change, none for a no-op: a listener re-evaluates the
  // whole graph. The snapshot copy is deliberate — a listener may unsubscribe inside it.
  private notify(kind: StateChange["kind"], name: string): void {
    if (this._listeners.length === 0) {
      return;
    }
    const change: StateChange = { kind, name };
    for (const fn of this._listeners.slice()) {
      fn(change);
    }
  }

  // Deterministic: everything sorted, so equal facts stringify byte-identically and
  // a test can diff a save. Empty collections are omitted.
  toJSON(): unknown {
    const out: Record<string, unknown> = { v: CONTENT_SAVE_VERSION };
    if (this._flags.size > 0) {
      out.flags = this.flags;
    }
    if (this._quests.size > 0) {
      const quests: Record<string, string> = {};
      for (const id of [...this._quests.keys()].toSorted()) {
        quests[id] = this._quests.get(id) as string;
      }
      out.quests = quests;
    }
    if (this._progress.size > 0) {
      const progress: Record<string, number> = {};
      for (const key of [...this._progress.keys()].toSorted()) {
        progress[key] = this._progress.get(key) as number;
      }
      out.progress = progress;
    }
    if (this._discovered.size > 0) {
      out.discovered = [...this._discovered].toSorted();
    }
    // Newer build's fields, last so they cannot shadow ours.
    for (const key of Object.keys(this._extra).toSorted()) {
      out[key] = this._extra[key];
    }
    return out;
  }

  // Unusable fields are DROPPED, never thrown on: one bad entry must not cost the save.
  // Unknown TOP-LEVEL fields are preserved verbatim, so a newer build's progress
  // survives a round-trip. Widening a KNOWN field is a version bump instead.
  fromJSON(value: unknown): void {
    this.clear();
    if (isRecord(value)) {
      const version = typeof value.v === "number" && Number.isFinite(value.v) ? value.v : 0;
      const raw = migrateSave(value, version);

      const flags = raw.flags;
      if (Array.isArray(flags)) {
        for (const f of flags) {
          if (isFlagName(f)) {
            this._flags.add(f);
          }
        }
      }

      const quests = raw.quests;
      if (isRecord(quests)) {
        for (const id of Object.keys(quests)) {
          const status = quests[id];
          // `unknown` is absence, so a save spelling it out normalises to nothing.
          if (isId(id) && isQuestStatus(status) && status !== "unknown") {
            this._quests.set(id, status);
          }
        }
      }

      const progress = raw.progress;
      if (isRecord(progress)) {
        for (const key of Object.keys(progress)) {
          const n = progress[key];
          if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
            continue;
          }
          const cut = key.lastIndexOf("/"); // the LAST slash: quest names carry their own
          if (cut <= 0) {
            continue;
          }
          if (!isId(key.slice(0, cut)) || !isObjectiveName(key.slice(cut + 1))) {
            continue;
          }
          this._progress.set(key, n);
        }
      }

      const discovered = raw.discovered;
      if (Array.isArray(discovered)) {
        for (const id of discovered) {
          if (isId(id)) {
            this._discovered.add(id);
          }
        }
      }

      for (const key of Object.keys(raw)) {
        if (!KNOWN_FIELDS.has(key)) {
          this._extra[key] = raw[key];
        }
      }
    }
    // Fires even for a garbage save: it was still cleared, so derived views must drop.
    this.notify("reset", "load");
  }

  // Notifies UNCONDITIONALLY: a session boundary, not a value change.
  reset(): void {
    this.clear();
    this.notify("reset", "reset");
  }

  private clear(): void {
    this._flags.clear();
    this._quests.clear();
    this._progress.clear();
    this._discovered.clear();
    this._extra = {};
  }
}
