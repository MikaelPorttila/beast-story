/**
 * Player preferences that OUTLIVE a session. A URL flag wins over a pref for one load.
 * A key's group name is fixed the day the setting ships and no longer tracks the panel's
 * tabs — read the tab off the panel, never off the key. Values are always strings.
 * try/catch on both sides: localStorage throws outright in some private-browsing modes.
 */

export interface Prefs {
  /** Master switch in front of the whole haptics channel; gated in feedback/index.ts. */
  hapticFeedback: boolean;
  /** Rumble strength, 0..1. 0 means the haptics channel issues nothing at all. */
  hapticIntensity: number;
  /** Camera-shake strength, 0..1, scaling the tuned per-cue amounts. */
  shakeIntensity: number;
  /** Music volume 0..1. 0 is MUTE — nothing fetched, no element built (audio/music.ts). */
  volume: number;
  /** `invertLookY` defaults TRUE (flight-stick feel). Pad sticks and touch look; not mouse. */
  invertLookX: boolean;
  invertLookY: boolean;
  /**
   * Go fullscreen when a game starts. Only honourable from a user gesture, so it is
   * issued from the New Game click (`StartMenu.start`) — a pad press cannot. Read past
   * `fullscreenSurvivesEscape()` (issue #83) so the row does not lie.
   */
  autoFullscreen: boolean;
  /** ISO 639-1, or null for "ask the browser" — NOT 'en'. i18n validates what ships. */
  lang: string | null;
  /** Autosave interval in MINUTES (0 = off) — not a 0..1 dial, so it skips `num01`. */
  autosaveMinutes: number;
}

export const AUTOSAVE_STEPS: ReadonlyArray<number> = [0, 1, 5, 10];

export const DEFAULT_PREFS: Readonly<Prefs> = {
  hapticFeedback: true,
  hapticIntensity: 1,
  shakeIntensity: 1,
  volume: 0.8,
  invertLookX: false,
  invertLookY: true,
  autoFullscreen: true,
  lang: null,
  autosaveMinutes: 5,
};

/** The ONLY place a storage key is spelled out. Field name and key may differ. */
export const STORAGE_KEYS: Readonly<Record<keyof Prefs, string>> = {
  hapticFeedback: "game.settings.controls.hapticFeedback",
  hapticIntensity: "game.settings.controls.hapticIntensity",
  invertLookX: "game.settings.controls.invertLookX",
  invertLookY: "game.settings.controls.invertLookY",
  shakeIntensity: "game.settings.graphics.shakeIntensity",
  autoFullscreen: "game.settings.graphics.autoFullscreen",
  volume: "game.settings.gameplay.volume",
  lang: "game.settings.gameplay.language",
  autosaveMinutes: "game.settings.gameplay.autosaveMinutes",
};

/** The pre-migration blob. Read once, then removed. See `migrate`. */
const LEGACY_KEY = "bs:prefs";

/**
 * Clamp into 0..1 on READ: stored text is user-writable, and a NaN reaches `playEffect`
 * as a rejected promise per frame. `Number('')` is 0, so blanks are rejected first.
 */
function num01(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") {
    return fallback;
  }
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Exactly `'true'`/`'false'`, never a truthiness test — `'0'` and `'off'` are truthy. */
function bool(raw: string | null, fallback: boolean): boolean {
  return raw === "true" ? true : raw === "false" ? false : fallback;
}

/** Shape only — whether the code SHIPS is i18n's question. The cap bounds a hand edit. */
function langCode(raw: string | null): string | null {
  return raw !== null && /^[a-z]{2,3}$/.test(raw) ? raw : null;
}

/** SNAPPED to an offered step, not clamped: the row is chips and a stored 7 lights none. */
function autosaveMinutes(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") {
    return fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    return fallback;
  }
  let best = AUTOSAVE_STEPS[0];
  for (const s of AUTOSAVE_STEPS) {
    if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  }
  return best;
}

function read(field: keyof Prefs): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEYS[field]);
  } catch {
    return null; // storage denied: every field falls back to its default
  }
}

/** null removes the key — "no preference". */
function write(field: keyof Prefs, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEYS[field]);
    } else {
      window.localStorage.setItem(STORAGE_KEYS[field], value);
    }
  } catch {
    /* private mode: the choice just does not persist past this session */
  }
}

let migrated = false;

/**
 * Move a pre-existing `bs:prefs` blob into the per-setting keys, once. An existing new
 * key is never overwritten (it is the newer value), and the blob is removed at the end.
 */
function migrate(): void {
  if (migrated) {
    return;
  }
  migrated = true;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEGACY_KEY);
  } catch {
    return; // storage denied: nothing to migrate, and nothing to lose
  }
  if (!raw) {
    return;
  }
  try {
    const blob = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    for (const field of Object.keys(STORAGE_KEYS) as Array<keyof Prefs>) {
      const v = blob[field];
      if (v === undefined || v === null) {
        continue;
      }
      if (read(field) !== null) {
        continue;
      } // the new key already wins
      // Blob values were never validated on write, so they go through the same parsers.
      if (field === "lang") {
        const c = typeof v === "string" ? langCode(v) : null;
        if (c) {
          write(field, c);
        }
      } else if (typeof DEFAULT_PREFS[field] === "boolean") {
        if (typeof v === "boolean") {
          write(field, String(v));
        }
      } else if (field === "autosaveMinutes") {
        // NOT a 0..1 value: the clamp below would migrate five minutes to one.
        if (typeof v === "number") {
          write(field, String(autosaveMinutes(String(v), DEFAULT_PREFS.autosaveMinutes)));
        }
      } else if (typeof v === "number" && Number.isFinite(v)) {
        write(field, String(Math.min(1, Math.max(0, v))));
      }
    }
  } catch {
    /* an unparseable blob is not worth rescuing; the defaults are correct */
  }
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* nothing to do: the read above already got what it could */
  }
}

export function loadPrefs(): Prefs {
  migrate();
  return {
    hapticFeedback: bool(read("hapticFeedback"), DEFAULT_PREFS.hapticFeedback),
    hapticIntensity: num01(read("hapticIntensity"), DEFAULT_PREFS.hapticIntensity),
    shakeIntensity: num01(read("shakeIntensity"), DEFAULT_PREFS.shakeIntensity),
    volume: num01(read("volume"), DEFAULT_PREFS.volume),
    invertLookX: bool(read("invertLookX"), DEFAULT_PREFS.invertLookX),
    invertLookY: bool(read("invertLookY"), DEFAULT_PREFS.invertLookY),
    autoFullscreen: bool(read("autoFullscreen"), DEFAULT_PREFS.autoFullscreen),
    lang: langCode(read("lang")),
    autosaveMinutes: autosaveMinutes(read("autosaveMinutes"), DEFAULT_PREFS.autosaveMinutes),
  };
}

/** Touches only the patched fields; returns what STORAGE now says, clamped and parsed. */
export function savePrefs(patch: Partial<Prefs>): Prefs {
  migrate(); // never write a new key over a blob that has not been read yet
  for (const field of Object.keys(patch) as Array<keyof Prefs>) {
    const v = patch[field];
    if (v === undefined) {
      continue;
    }
    write(field, v === null ? null : String(v));
  }
  return loadPrefs();
}
