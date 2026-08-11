/**
 * WHERE A CHARACTER LIVES BETWEEN SESSIONS — the save store (issue #171).
 *
 * This file is STORAGE AND NOTHING ELSE. It opens the database, validates what
 * comes out of it, and writes what it is handed; it never asks the world, the
 * registry or the roster a question. The reason is the same one that keeps
 * content/state.ts free of the content registry: whether `sword-iron` is still
 * an item this build ships, or `overworld` still a zone, is a question about
 * the GAME, and the answer changes with every content edit. A store that
 * answered it would drop a player's rare weapon the week it was renamed. So
 * everything here validates SHAPE — is this a finite number, is this a
 * non-empty string — and main.ts, which owns the session, validates MEANING on
 * the way in. One of those two jobs belongs to a file that can be read without
 * knowing the game, and this is that file.
 *
 * TWO TABLES, AND THE SPLIT IS THE WHOLE SCALING STORY. `saves` holds one small
 * row per character — the name, the power level, when it was touched — and
 * `payloads` holds the document, keyed by the same id. The title screen lists
 * characters, and listing is the operation that happens while a player is
 * waiting and looking at a menu, so it must not deserialise a bag, a roster and
 * a quest log per row to draw a name. Everything the list draws is denormalised
 * into the metadata row AT WRITE TIME, from the document being written, by the
 * one function that writes either of them — so the two tables cannot drift, and
 * a list of twenty characters costs twenty tiny rows.
 *
 * Dexie's `stores()` declares INDEXES, not a schema: a field nobody queries by
 * needs no declaration and no version bump. So a system that ships next year
 * adds a field to `SaveDocument` and nothing here moves. What DOES move is
 * `SAVE_DOC_VERSION` and `migrateSaveDoc` below, borrowed wholesale from
 * content/state.ts — the payload carries its own revision, independent of the
 * database's, because the two change for different reasons and a build that
 * conflated them would have to bump the database to add a field to the save.
 *
 * VALIDATE ON READ, DROP RATHER THAN THROW. The house rule, from core/prefs.ts
 * through content/state.ts and now here. A save is a file on a player's disk: a
 * half-completed write, a hand edit, a value from a build that has not shipped
 * yet. One unusable entry costs that entry; a throw out of a load costs the
 * character. The only thing that returns null is a record that is not an object
 * at all, because there is nothing left to salvage from it.
 *
 * THE GAME NEVER REQUIRES THE DATABASE. IndexedDB is denied outright in some
 * private-browsing modes and can fail to open for reasons no caller can fix, so
 * every entry point here degrades to "no saves": the Load button stays down,
 * autosave never arms, and play is unaffected. `nostore=1` (core/flags.ts) is
 * the same state asked for on purpose — a sandbox or a probe that must leave no
 * mark — which means the unavailable path is exercised by the test suite on
 * every run rather than only on the machines that break.
 */

import Dexie, { type Table } from 'dexie';
import { flags } from './flags';

/**
 * The payload revision. THE MIGRATION SEAM IS `migrateSaveDoc` BELOW: bump
 * this, add a branch there, and every load of an older document passes through
 * it exactly once on its way in. Nothing else in the file may read a version
 * number — a second place that switches on it is how two readers start
 * disagreeing about what version 2 meant.
 *
 * Deliberately NOT the same number as the database version above it. The
 * database changes when an INDEX changes; this changes when the meaning of a
 * field changes. Tying them would mean either a database upgrade nobody needs
 * or a silent payload change nobody migrated.
 */
export const SAVE_DOC_VERSION = 1;

/** Where the hero stood. `zoneId` is a ZoneManager id, not a content id. */
export interface SaveLocation {
  zoneId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * One bonded beast.
 *
 * `level`/`xp` are the save game (see the note on `BeastActor.reset`), and
 * stats are recomputed from the level on the way back in. `knownSkillIds` is
 * the one that cannot be recomputed: a beast learns skills by levelling AND by
 * purchase at a den, so the list is a record of what the player bought.
 */
export interface SavedBeast {
  speciesId: string;
  level: number;
  xp: number;
  xpToNext: number;
  hp: number;
  knownSkillIds: string[];
}

/**
 * A character, whole.
 *
 * Everything here is a plain JSON value: IndexedDB stores structured clones, so
 * a class instance or a `Vector3` would either throw on write or come back as a
 * bare object with no methods. The seams that produce these values live on the
 * objects that own them (`Inventory.toJSON`, `SlotLayout.toJSON`, and so on),
 * which is the reset-in-owner rule pointed the other way.
 *
 * WHAT IS ABSENT IS AS DELIBERATE AS WHAT IS HERE. Derived state is not stored:
 * `attackStat` is a weapon plus a buff plus a base, so restoring the weapon and
 * re-running `applyLoadout` is the only way it cannot disagree with itself.
 * Transient state is not stored either — a potion timer, a cooldown, a mount —
 * because a save is a place a player comes back to, not a frame paused
 * mid-swing.
 */
export interface SaveDocument {
  v: number;
  /** What the player typed on New Game. Display only; the id is the key. */
  name: string;
  player: { hp: number; maxHp: number };
  location: SaveLocation;
  /** The NET purse. The pickupTotal/spent split is main.ts's business. */
  currency: number;
  /**
   * ORDERED, and that is load-bearing rather than incidental: the wall assigns
   * a new row the first free cell in bag order, so a bag restored in a
   * different order lays itself out differently than the player left it.
   */
  bag: Array<[id: string, count: number]>;
  /** Row id (item ids and `beast:` ids) to the cell it sits in. */
  slots: Record<string, number>;
  equippedWeapon: string | null;
  readiedOrb: string | null;
  beasts: SavedBeast[];
  /**
   * SPECIES IDS, NEVER ROSTER INDICES. The roster is built from the registry's
   * module array, so an index means "the beast in slot 3 as the registry stood
   * the day this was written" — add a species and every save points at the
   * wrong companion. Same disease as `mainQuestProgress = 7`; same cure.
   */
  party: { primary: string | null; support: string | null };
  appearance: { hairStyle: string; hairColour: string };
  /** `ContentStateStore.toJSON()`, carried verbatim and never inspected. */
  content: unknown;
  dayPhase: number;
  /**
   * Top-level fields a NEWER build wrote and this one has never heard of,
   * carried through untouched (the promise content/state.ts makes, made again
   * here for the same reason). A player who earns something on a newer build
   * and then opens an older one must not have it silently deleted by the next
   * autosave. The caller is responsible for handing these back on the next
   * write of the same character — see main.ts.
   */
  extra?: Record<string, unknown>;
}

/**
 * The slot list, and everything the title screen draws.
 *
 * Derived from the document at write time rather than stored alongside it by a
 * caller, so there is no way to update a character and leave the list saying
 * something else.
 */
export interface SaveMeta {
  id: number;
  name: string;
  /** Sum of the levels of every bonded beast. The issue's "power level". */
  powerLevel: number;
  zoneId: string;
  createdAt: number;
  updatedAt: number;
}

interface PayloadRow {
  id: number;
  doc: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

class SaveDb extends Dexie {
  saves!: Table<SaveMeta, number>;
  payloads!: Table<PayloadRow, number>;

  constructor() {
    super('beast-story-saves');
    // Only what is QUERIED is declared. `updatedAt` is indexed because the list
    // is drawn most-recent-first; `name` and `powerLevel` are not, because
    // nothing looks a character up by either and an unused index is a write
    // cost on every autosave.
    this.version(1).stores({
      saves: '++id, updatedAt',
      payloads: 'id',
    });
  }
}

let db: SaveDb | null = null;
let openFailed = false;

/**
 * The database, or null when there will not be one.
 *
 * Construction is lazy so a `nostore=1` boot never touches IndexedDB at all,
 * and a failure is remembered: a browser that refused once refuses every time,
 * and retrying per autosave would mean a rejected promise every few minutes for
 * the rest of the session.
 */
function open(): SaveDb | null {
  if (flags.noStore || openFailed) return null;
  if (db) return db;
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    db = new SaveDb();
    return db;
  } catch (err) {
    openFailed = true;
    db = null;
    console.warn('[saves] storage unavailable; this session will not persist', err);
    return null;
  }
}

/**
 * Whether saving is possible AT ALL — synchronous, for the menu to draw with.
 *
 * Best effort by construction: a database that opens fine and then fails on a
 * write cannot be predicted from here. That is why every other function in this
 * file also degrades on its own rather than trusting this one.
 */
export function savesAvailable(): boolean {
  return !flags.noStore && !openFailed && typeof indexedDB !== 'undefined';
}

/** Mark the store unusable after a failed operation, once, with one warning. */
function fail(what: string, err: unknown): void {
  if (!openFailed) console.warn(`[saves] ${what} failed; this session will not persist`, err);
  openFailed = true;
}

// ---------------------------------------------------------------------------
// Validation — shape only. See the header.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A finite number, or the fallback.
 *
 * `NaN` is the value this exists for: it survives every arithmetic operation
 * downstream and every comparison against it is false, so a `NaN` position
 * teleports the hero nowhere in particular and a `NaN` level makes a beast that
 * can never level again. Neither reads as a corrupt save to the player.
 */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string, or the fallback. Ids and names both come through here. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** A non-empty string, or null — for the fields whose absence is meaningful. */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Names are player-typed, so they are also length-capped on the way in. */
const MAX_NAME_LEN = 24;

function name(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s.slice(0, MAX_NAME_LEN) : '';
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'v', 'name', 'player', 'location', 'currency', 'bag', 'slots',
  'equippedWeapon', 'readiedOrb', 'beasts', 'party', 'appearance',
  'content', 'dayPhase',
]);

/**
 * Upgrade a document written against an older payload version.
 *
 * Nothing shipped before version 1, so this is a seam rather than a
 * transformation. Two properties it keeps when it stops being empty: it runs
 * ONCE, on the way in, so the rest of the file only ever sees today's shape;
 * and a version NEWER than this build passes through untouched rather than
 * being rejected — the field reads below drop what they cannot use and `extra`
 * preserves the rest, which between them is the best an old build can honestly
 * do with a new save.
 */
function migrateSaveDoc(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  if (from >= SAVE_DOC_VERSION) return raw;
  // v0 is "a document with no `v` at all" — nothing ever wrote one. A future
  // v1 -> v2 branch goes here.
  return raw;
}

function parseBeast(value: unknown): SavedBeast | null {
  if (!isRecord(value)) return null;
  const speciesId = strOrNull(value.speciesId);
  if (!speciesId) return null;   // a beast with no species is not a beast
  const level = Math.max(1, Math.round(num(value.level, 1)));
  const skills = Array.isArray(value.knownSkillIds)
    ? value.knownSkillIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  return {
    speciesId,
    level,
    xp: Math.max(0, num(value.xp, 0)),
    // 0 would mean "levels on the next point of xp, forever". The restorer
    // recomputes this from the level anyway; a sane floor is what keeps a
    // corrupt value from being visible in the half-second before it does.
    xpToNext: Math.max(1, num(value.xpToNext, 25)),
    hp: Math.max(0, num(value.hp, 0)),
    knownSkillIds: skills,
  };
}

/**
 * A stored record, as this build understands it.
 *
 * Every field lands on a usable value: the caller gets a whole document or
 * null, never a half-populated one it has to re-check. What it does NOT do is
 * decide whether the values mean anything — an item id nothing ships and a zone
 * that was deleted both come through here intact, for main.ts to resolve.
 */
function parseDoc(value: unknown): SaveDocument | null {
  if (!isRecord(value)) return null;
  const version = num(value.v, 0);
  const raw = migrateSaveDoc(value, version);

  const loc = isRecord(raw.location) ? raw.location : {};
  const player = isRecord(raw.player) ? raw.player : {};
  const party = isRecord(raw.party) ? raw.party : {};
  const look = isRecord(raw.appearance) ? raw.appearance : {};

  const bag: Array<[string, number]> = [];
  if (Array.isArray(raw.bag)) {
    for (const entry of raw.bag) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const id = strOrNull(entry[0]);
      const count = Math.floor(num(entry[1], 0));
      if (id && count > 0) bag.push([id, count]);
    }
  }

  const slots: Record<string, number> = {};
  if (isRecord(raw.slots)) {
    for (const key of Object.keys(raw.slots)) {
      const cell = num(raw.slots[key], -1);
      if (key.length > 0 && Number.isInteger(cell) && cell >= 0) slots[key] = cell;
    }
  }

  const beasts: SavedBeast[] = [];
  if (Array.isArray(raw.beasts)) {
    for (const b of raw.beasts) {
      const parsed = parseBeast(b);
      if (parsed) beasts.push(parsed);
    }
  }

  const maxHp = Math.max(1, num(player.maxHp, 100));
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.has(key)) extra[key] = raw[key];

  return {
    v: SAVE_DOC_VERSION,
    name: name(raw.name),
    player: { hp: Math.max(0, Math.min(maxHp, num(player.hp, maxHp))), maxHp },
    location: {
      zoneId: str(loc.zoneId, ''),
      x: num(loc.x, NaN),
      y: num(loc.y, NaN),
      z: num(loc.z, NaN),
      yaw: num(loc.yaw, 0),
    },
    currency: Math.max(0, Math.floor(num(raw.currency, 0))),
    bag,
    slots,
    equippedWeapon: strOrNull(raw.equippedWeapon),
    readiedOrb: strOrNull(raw.readiedOrb),
    beasts,
    party: { primary: strOrNull(party.primary), support: strOrNull(party.support) },
    appearance: { hairStyle: str(look.hairStyle, ''), hairColour: str(look.hairColour, '') },
    content: raw.content,
    dayPhase: num(raw.dayPhase, 0),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  // Note the location fields: an unusable coordinate becomes NaN and is NOT
  // repaired here. Where a hero belongs when his saved ground is gone is a
  // question about the world — the nearest town, the start camp, the spawn
  // point — and this file has never heard of any of them. NaN is how it says
  // "there was nothing usable here" to the one caller that can answer.
}

/** The stored form: known fields, then a newer build's, which cannot shadow. */
function serialize(doc: SaveDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    v: SAVE_DOC_VERSION,
    name: doc.name,
    player: { hp: doc.player.hp, maxHp: doc.player.maxHp },
    location: { ...doc.location },
    currency: doc.currency,
    bag: doc.bag.map(([id, count]) => [id, count]),
    slots: { ...doc.slots },
    equippedWeapon: doc.equippedWeapon,
    readiedOrb: doc.readiedOrb,
    beasts: doc.beasts.map((b) => ({ ...b, knownSkillIds: [...b.knownSkillIds] })),
    party: { ...doc.party },
    appearance: { ...doc.appearance },
    content: doc.content,
    dayPhase: doc.dayPhase,
  };
  for (const key of Object.keys(doc.extra ?? {})) {
    if (!KNOWN_FIELDS.has(key)) out[key] = (doc.extra as Record<string, unknown>)[key];
  }
  return out;
}

/** What the list row says, derived from the document it is written beside. */
function metaOf(doc: SaveDocument): Pick<SaveMeta, 'name' | 'powerLevel' | 'zoneId'> {
  return {
    name: doc.name,
    powerLevel: doc.beasts.reduce((n, b) => n + b.level, 0),
    zoneId: doc.location.zoneId,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every character, most recently played first — metadata only.
 *
 * An empty list is also what an unavailable database returns, and the menu
 * treats the two the same way (no rows, Load stays down). That is deliberate:
 * "you have no characters" and "I cannot reach your characters" lead to the
 * same screen, and the second is already on the console for whoever needs it.
 */
export async function listSaves(): Promise<SaveMeta[]> {
  const store = open();
  if (!store) return [];
  try {
    const rows = await store.saves.orderBy('updatedAt').reverse().toArray();
    return rows.filter((r) => typeof r.id === 'number');
  } catch (err) {
    fail('listing saves', err);
    return [];
  }
}

/** One character's document, validated, or null when there is nothing usable. */
export async function readSave(id: number): Promise<SaveDocument | null> {
  const store = open();
  if (!store) return null;
  try {
    const row = await store.payloads.get(id);
    return row ? parseDoc(row.doc) : null;
  } catch (err) {
    fail('reading a save', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Writes in flight, and the latest document waiting behind each.
 *
 * COALESCING RATHER THAN QUEUEING, and the difference matters at exactly the
 * moment this system is under load: an autosave on a timer, an autosave on a
 * quest completing and an autosave on the way out of the game can all land
 * inside a second, and they all describe the SAME character. Queueing them
 * writes the same row three times and leaves the last one correct; coalescing
 * writes it once. A superseded document was never worth the write — nobody can
 * load it, because the only id it could be loaded from now holds the newer one.
 */
const pending = new Map<number, SaveDocument>();
let pump: Promise<void> | null = null;

async function drain(store: SaveDb): Promise<void> {
  while (pending.size > 0) {
    const [id, doc] = pending.entries().next().value as [number, SaveDocument];
    pending.delete(id);
    try {
      await store.transaction('rw', store.saves, store.payloads, async () => {
        const prev = await store.saves.get(id);
        const now = Date.now();
        await store.saves.put({
          id,
          ...metaOf(doc),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        });
        await store.payloads.put({ id, doc: serialize(doc) });
      });
    } catch (err) {
      fail('writing a save', err);
      pending.clear();   // the store is down; the queue behind it is not going anywhere
    }
  }
  pump = null;
}

/**
 * Write a character, creating one when `id` is null. Resolves to its id.
 *
 * The create path is awaited rather than coalesced because the caller needs the
 * id back to write to next time, and two coalesced creates are two characters
 * rather than one — the one case where "the newest wins" is the wrong rule.
 *
 * Both paths resolve to 0 when there is no store. A caller that treats that as
 * an id writes into a record that does not exist and reads nothing back, which
 * is exactly what a session with no persistence should do.
 */
export async function writeSave(id: number | null, doc: SaveDocument): Promise<number> {
  const store = open();
  if (!store) return id ?? 0;
  if (id === null) {
    try {
      const now = Date.now();
      return await store.transaction('rw', store.saves, store.payloads, async () => {
        const fresh = await store.saves.add({
          ...metaOf(doc),
          createdAt: now,
          updatedAt: now,
        } as SaveMeta);
        await store.payloads.put({ id: fresh, doc: serialize(doc) });
        return fresh;
      });
    } catch (err) {
      fail('creating a save', err);
      return 0;
    }
  }
  pending.set(id, doc);
  pump ??= drain(store);
  await pump;
  return id;
}

/** Forget a character, both rows together. */
export async function deleteSave(id: number): Promise<void> {
  const store = open();
  if (!store) return;
  pending.delete(id);   // whatever was queued for it is now moot
  try {
    await store.transaction('rw', store.saves, store.payloads, async () => {
      await store.saves.delete(id);
      await store.payloads.delete(id);
    });
  } catch (err) {
    fail('deleting a save', err);
  }
}
