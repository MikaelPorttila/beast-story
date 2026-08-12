/**
 * The save store (issue #171). It validates SHAPE only; main.ts validates MEANING on load.
 * `saves` holds one metadata row per character, denormalised at write time so listing never
 * deserialises a payload; `payloads` holds the document. Dexie's `stores()` declares INDEXES,
 * so a new `SaveDocument` field needs no database bump — only `SAVE_DOC_VERSION` tracks it.
 * IndexedDB can be denied outright, so every entry point degrades to "no saves".
 */

import Dexie, { type Table } from "dexie";
import { flags } from "./flags";

/** Payload revision, separate from the database version. Bump it, branch in `migrateSaveDoc`. */
export const SAVE_DOC_VERSION = 1;

/**
 * `zoneId` is a ZoneManager id, not a content id. x/y/z are world coordinates and are wrong
 * on a MOVING frame, so `carrierId`, `localX`/`localZ` and a frame-relative `yaw` win there.
 */
export interface SaveLocation {
  zoneId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** What he stood on when it was not ground; `resolveSafeGround` re-measures the rise. */
  perchY?: number;
  carrierId?: string;
  localX?: number;
  localZ?: number;
}

/** Stats are recomputed from the level; `knownSkillIds` cannot be — skills are purchased. */
export interface SavedBeast {
  speciesId: string;
  level: number;
  xp: number;
  xpToNext: number;
  hp: number;
  knownSkillIds: string[];
}

/** Plain JSON only — IndexedDB clones, so a class instance returns methodless. */
export interface SaveDocument {
  v: number;
  name: string;
  player: { hp: number; maxHp: number };
  location: SaveLocation;
  /** The NET purse. The pickupTotal/spent split is main.ts's business. */
  currency: number;
  /** ORDERED, and load-bearing: bag order is the order the wall hands out free cells. */
  bag: Array<[id: string, count: number]>;
  slots: Record<string, number>;
  equippedWeapon: string | null;
  readiedOrb: string | null;
  beasts: SavedBeast[];
  /** SPECIES IDS, never roster indices — an index shifts when a species is added. */
  party: { primary: string | null; support: string | null };
  appearance: { hairStyle: string; hairColour: string };
  /** `MountKind` ids, not booleans, so a new kind needs no migration. Empty on a new character. */
  mounts: string[];
  /** `ContentStateStore.toJSON()`, carried verbatim and never inspected. */
  content: unknown;
  dayPhase: number;
  /** Fields a NEWER build wrote, carried untouched so this build's autosave cannot drop them. */
  extra?: Record<string, unknown>;
}

/** Derived from the document at write time, so the list cannot disagree with it. */
export interface SaveMeta {
  id: number;
  name: string;
  powerLevel: number;
  zoneId: string;
  createdAt: number;
  updatedAt: number;
}

interface PayloadRow {
  id: number;
  doc: Record<string, unknown>;
}

class SaveDb extends Dexie {
  saves!: Table<SaveMeta, number>;
  payloads!: Table<PayloadRow, number>;

  constructor() {
    super("beast-story-saves");
    // Only what is QUERIED is indexed — an unused index costs every autosave a write.
    this.version(1).stores({
      saves: "++id, updatedAt",
      payloads: "id",
    });
  }
}

let db: SaveDb | null = null;
let openFailed = false;

/** Lazy, so `nostore=1` never touches IndexedDB. A failure is remembered, never retried. */
function open(): SaveDb | null {
  if (flags.noStore || openFailed) {
    return null;
  }
  if (db) {
    return db;
  }
  try {
    if (typeof indexedDB === "undefined") {
      throw new Error("no IndexedDB");
    }
    db = new SaveDb();
    return db;
  } catch (err) {
    openFailed = true;
    db = null;
    console.warn("[saves] storage unavailable; this session will not persist", err);
    return null;
  }
}

/** Synchronous, for the menu to draw with. Best effort — every other function also degrades. */
export function savesAvailable(): boolean {
  return !flags.noStore && !openFailed && typeof indexedDB !== "undefined";
}

/** Mark the store unusable after a failed operation, once, with one warning. */
function fail(what: string, err: unknown): void {
  if (!openFailed) {
    console.warn(`[saves] ${what} failed; this session will not persist`, err);
  }
  openFailed = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or the fallback. A NaN survives every operation downstream. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Names are player-typed, so they are also length-capped on the way in. */
const MAX_NAME_LEN = 24;

function name(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s.slice(0, MAX_NAME_LEN) : "";
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "v",
  "name",
  "player",
  "location",
  "currency",
  "bag",
  "slots",
  "equippedWeapon",
  "readiedOrb",
  "beasts",
  "party",
  "appearance",
  "content",
  "dayPhase",
  "mounts",
]);

/** Runs ONCE on the way in, so the rest of the file sees today's shape. Newer passes through. */
function migrateSaveDoc(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  if (from >= SAVE_DOC_VERSION) {
    return raw;
  }
  // A future v1 -> v2 branch goes here; nothing ever wrote a v0.
  return raw;
}

function parseBeast(value: unknown): SavedBeast | null {
  if (!isRecord(value)) {
    return null;
  }
  const speciesId = strOrNull(value.speciesId);
  if (!speciesId) {
    return null;
  } // a beast with no species is not a beast
  const level = Math.max(1, Math.round(num(value.level, 1)));
  const skills = Array.isArray(value.knownSkillIds)
    ? value.knownSkillIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return {
    speciesId,
    level,
    xp: Math.max(0, num(value.xp, 0)),
    // 0 would mean "levels on the next point of xp, forever".
    xpToNext: Math.max(1, num(value.xpToNext, 25)),
    hp: Math.max(0, num(value.hp, 0)),
    knownSkillIds: skills,
  };
}

/** A whole document or null, never half-populated. Whether the ids MEAN anything is main.ts's. */
function parseDoc(value: unknown): SaveDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  const version = num(value.v, 0);
  const raw = migrateSaveDoc(value, version);

  const loc = isRecord(raw.location) ? raw.location : {};
  const player = isRecord(raw.player) ? raw.player : {};
  const party = isRecord(raw.party) ? raw.party : {};
  const look = isRecord(raw.appearance) ? raw.appearance : {};

  const bag: Array<[string, number]> = [];
  if (Array.isArray(raw.bag)) {
    for (const entry of raw.bag) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const id = strOrNull(entry[0]);
      const count = Math.floor(num(entry[1], 0));
      if (id && count > 0) {
        bag.push([id, count]);
      }
    }
  }

  const slots: Record<string, number> = {};
  if (isRecord(raw.slots)) {
    for (const key of Object.keys(raw.slots)) {
      const cell = num(raw.slots[key], -1);
      if (key.length > 0 && Number.isInteger(cell) && cell >= 0) {
        slots[key] = cell;
      }
    }
  }

  const beasts: SavedBeast[] = [];
  if (Array.isArray(raw.beasts)) {
    for (const b of raw.beasts) {
      const parsed = parseBeast(b);
      if (parsed) {
        beasts.push(parsed);
      }
    }
  }

  const maxHp = Math.max(1, num(player.maxHp, 100));
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = raw[key];
  }

  return {
    v: SAVE_DOC_VERSION,
    name: name(raw.name),
    player: { hp: Math.max(0, Math.min(maxHp, num(player.hp, maxHp))), maxHp },
    location: {
      zoneId: str(loc.zoneId, ""),
      x: num(loc.x, NaN),
      y: num(loc.y, NaN),
      z: num(loc.z, NaN),
      yaw: num(loc.yaw, 0),
      // Absent stays absent — a 0 here would be a place rather than a silence.
      ...(Number.isFinite(num(loc.perchY, NaN)) ? { perchY: num(loc.perchY, 0) } : {}),
      // All three or none: a half-pair is not a place, and drops to the world coordinates.
      ...(strOrNull(loc.carrierId) !== null &&
      Number.isFinite(num(loc.localX, NaN)) &&
      Number.isFinite(num(loc.localZ, NaN))
        ? {
            carrierId: loc.carrierId as string,
            localX: num(loc.localX, 0),
            localZ: num(loc.localZ, 0),
          }
        : {}),
    },
    currency: Math.max(0, Math.floor(num(raw.currency, 0))),
    bag,
    slots,
    equippedWeapon: strOrNull(raw.equippedWeapon),
    readiedOrb: strOrNull(raw.readiedOrb),
    beasts,
    party: { primary: strOrNull(party.primary), support: strOrNull(party.support) },
    appearance: { hairStyle: str(look.hairStyle, ""), hairColour: str(look.hairColour, "") },
    mounts: Array.isArray(raw.mounts)
      ? raw.mounts.map((k) => strOrNull(k)).filter((k): k is string => k !== null)
      : [],
    content: raw.content,
    dayPhase: num(raw.dayPhase, 0),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  // An unusable coordinate becomes NaN and is NOT repaired here — that needs the world.
}

/** The stored form: known fields, then a newer build's, which cannot shadow. */
function serialize(doc: SaveDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    v: SAVE_DOC_VERSION,
    name: doc.name,
    player: { hp: doc.player.hp, maxHp: doc.player.maxHp },
    // Spread, so the optional carrier fields travel without being named twice.
    location: { ...doc.location },
    currency: doc.currency,
    bag: doc.bag.map(([id, count]) => [id, count]),
    slots: { ...doc.slots },
    equippedWeapon: doc.equippedWeapon,
    readiedOrb: doc.readiedOrb,
    beasts: doc.beasts.map((b) => ({ ...b, knownSkillIds: [...b.knownSkillIds] })),
    party: { ...doc.party },
    appearance: { ...doc.appearance },
    mounts: [...doc.mounts],
    content: doc.content,
    dayPhase: doc.dayPhase,
  };
  for (const key of Object.keys(doc.extra ?? {})) {
    if (!KNOWN_FIELDS.has(key)) {
      out[key] = (doc.extra as Record<string, unknown>)[key];
    }
  }
  return out;
}

function metaOf(doc: SaveDocument): Pick<SaveMeta, "name" | "powerLevel" | "zoneId"> {
  return {
    name: doc.name,
    powerLevel: doc.beasts.reduce((n, b) => n + b.level, 0),
    zoneId: doc.location.zoneId,
  };
}

/** Most recently played first, metadata only. An unavailable database also returns empty. */
export async function listSaves(): Promise<SaveMeta[]> {
  const store = open();
  if (!store) {
    return [];
  }
  try {
    const rows = await store.saves.orderBy("updatedAt").reverse().toArray();
    return rows.filter((r) => typeof r.id === "number");
  } catch (err) {
    fail("listing saves", err);
    return [];
  }
}

export async function readSave(id: number): Promise<SaveDocument | null> {
  const store = open();
  if (!store) {
    return null;
  }
  try {
    const row = await store.payloads.get(id);
    return row ? parseDoc(row.doc) : null;
  } catch (err) {
    fail("reading a save", err);
    return null;
  }
}

/** Latest document per character. COALESCED, not queued — a superseded doc cannot be loaded. */
const pending = new Map<number, SaveDocument>();
let pump: Promise<void> | null = null;

async function drain(store: SaveDb): Promise<void> {
  while (pending.size > 0) {
    const [id, doc] = pending.entries().next().value as [number, SaveDocument];
    pending.delete(id);
    try {
      await store.transaction("rw", store.saves, store.payloads, async () => {
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
      fail("writing a save", err);
      pending.clear(); // the store is down; the queue behind it is not going anywhere
    }
  }
  pump = null;
}

/**
 * Creates when `id` is null; that path is NOT coalesced (two creates would be two
 * characters). Resolves to 0 when there is no store.
 */
export async function writeSave(id: number | null, doc: SaveDocument): Promise<number> {
  const store = open();
  if (!store) {
    return id ?? 0;
  }
  if (id === null) {
    try {
      const now = Date.now();
      return await store.transaction("rw", store.saves, store.payloads, async () => {
        const fresh = await store.saves.add({
          ...metaOf(doc),
          createdAt: now,
          updatedAt: now,
        } as SaveMeta);
        await store.payloads.put({ id: fresh, doc: serialize(doc) });
        return fresh;
      });
    } catch (err) {
      fail("creating a save", err);
      return 0;
    }
  }
  pending.set(id, doc);
  pump ??= drain(store);
  await pump;
  return id;
}

export async function deleteSave(id: number): Promise<void> {
  const store = open();
  if (!store) {
    return;
  }
  pending.delete(id); // whatever was queued for it is now moot
  try {
    await store.transaction("rw", store.saves, store.payloads, async () => {
      await store.saves.delete(id);
      await store.payloads.delete(id);
    });
  } catch (err) {
    fail("deleting a save", err);
  }
}
