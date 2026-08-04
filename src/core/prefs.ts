/**
 * Player preferences that OUTLIVE a session.
 *
 * Distinct from core/flags.ts, which is the diagnostic layer: a flag answers
 * "what is this costing?" for one measurement run and is never set in play,
 * while this is what a player chose and expects to still be true tomorrow.
 * Where both have an opinion, the URL wins — see `resolve`.
 *
 * PERSISTENCE is a KEY PER SETTING, named `game.settings.<group>.<name>`, each
 * holding one string. It used to be a single `bs:prefs` JSON blob, and the swap
 * is worth stating because the blob was not obviously wrong:
 *
 *   - A key per setting is what the storage inspector in devtools is FOR. A
 *     bug report that says "vibration is off and I never turned it off" is one
 *     glance at `game.settings.controls.hapticFeedback` rather than reading a
 *     minified blob.
 *   - Two tabs no longer clobber each other. `savePrefs` on a blob is
 *     read-modify-write of EVERY field, so a second tab that changed the
 *     language and a first tab that then changed a toggle wrote the first tab's
 *     stale language back over it. Per-key writes only touch what changed.
 *   - A setting can be added, renamed or dropped without the shape of what is
 *     already stored mattering. An unknown key is ignored; a missing one is the
 *     default.
 *
 * The group in the middle (`controls` / `graphics` / `gameplay`) is part of the
 * name rather than a nested object because there is no nesting in localStorage
 * — it is a flat string map, and the dotted key is how everything else in the
 * world spells a namespace in one. It was chosen to match how each setting is
 * PRESENTED, and it is NOT a promise that it still does: a group is fixed on the
 * day a setting ships, and the settings panel has since grown four tabs
 * (ui/settings.ts) that two of these no longer line up with — `volume` is
 * `gameplay` and is shown under Sound, `autoFullscreen` is `graphics` and is
 * shown under Gameplay. Renaming either key to tidy that up would silently reset
 * the choice of every player who has already made one, which is a worse thing
 * than a name nobody sees. Read the tab off the panel, never off the key.
 *
 * Values are strings, always: `'true'` / `'false'` for the toggles, a decimal
 * for the 0..1 dials, an ISO 639-1 code for the language. No JSON at all — a
 * `JSON.parse` per key would buy nothing and would put a throw in the path of
 * every read.
 *
 * try/catch on BOTH sides, because localStorage throws outright in some
 * private-browsing modes. A failure degrades to defaults, which is the harmless
 * direction — the player gets the stock feel rather than an exception out of a
 * constructor.
 */

export interface Prefs {
  /**
   * Controller vibration, on or off — the master switch in front of everything
   * the haptics channel does, `hapticIntensity` included.
   *
   * Two settings rather than one because they answer different questions. The
   * intensity is a dial for someone tuning the feel, and it lives in the dev
   * console; this is the checkbox in Settings for someone who does not want
   * their pad to move, and it is the one a player has to be able to find. OFF
   * means nothing is issued to any motor — see the gate in feedback/index.ts,
   * which is the single place every cue passes through.
   */
  hapticFeedback: boolean;
  /** Rumble strength, 0..1. 0 means the haptics channel issues nothing at all. */
  hapticIntensity: number;
  /** Camera-shake strength, 0..1, scaling the tuned per-cue amounts. */
  shakeIntensity: number;
  /**
   * MUSIC VOLUME, 0..1, and 0 is MUTE — not a quiet setting but the whole
   * feature switched off: nothing is fetched, no element is constructed, and
   * whatever was playing is unloaded (src/audio/music.ts).
   *
   * One number rather than a level plus a mute flag, and the argument is that
   * the second field could only ever disagree with the first. "Muted at 80%"
   * and "at 0%" sound identical and differ only in what a later un-mute
   * restores, which is a convenience the panel already provides — the row is a
   * strip of chips (OFF · 20 · 40 · 60 · 80 · 100), so coming back from OFF is
   * the same one tap that leaving it was.
   *
   * 0.8 by default because music under a game is a bed, not the foreground, and
   * because a player who finds it too loud reaches for a setting while one who
   * finds it too quiet concludes there is none.
   *
   * NOT the SFX channel. src/feedback/audio.ts is still a seam with no sound
   * behind it; when cues arrive they want a level of their own, since the
   * balance between a song and a sword hit is not one slider's business.
   */
  volume: number;
  /**
   * Stick look inversion, per axis.
   *
   * `invertLookY` DEFAULTS TO TRUE, and that is the shipped feel rather than an
   * arbitrary choice: passing the stick's raw axis through gives the mouse's own
   * mapping (stick up looks up), which was tested on hardware and read as
   * backwards in the hand. The flight-stick convention is what a pad wants.
   *
   * IT IS A PROPERTY OF STICKS, NOT OF THE PAD. A pad's right stick and the
   * touch overlay's look pad are the same control on different hardware — both
   * are rate controls a thumb deflects — so both read these, and a player who
   * sets it on one device finds it set on the other. The touch overlay was NOT
   * routed through them until it was made to be, which meant a phone shipped
   * the mapping this default exists to say is backwards, and a phone player had
   * a switch on their settings screen that did nothing at all.
   *
   * The MOUSE is not routed through these and must not be — nobody expects an
   * inverted mouse, and a pointer disagreeing with a stick here is correct
   * rather than an inconsistency to tidy away.
   */
  invertLookX: boolean;
  invertLookY: boolean;
  /**
   * Go fullscreen when a game is STARTED — New Game today, Load when there is
   * something to load. On by default.
   *
   * This replaced a "Play fullscreen?" question the title screen asked as a step
   * of its own, and the reason is that the question was never the interesting
   * part: a player who wants fullscreen wants it every time, and one who does
   * not wants to be left alone. Doing it and offering a switch says the same
   * thing in one fewer tap for everybody.
   *
   * IT CAN ONLY BE HONOURED FROM A GESTURE. `requestFullscreen()` needs a user
   * activation, so it is issued from the New Game click/keypress itself and
   * nowhere else — see `StartMenu.start`. A pad press is not an activation in
   * any browser, so someone starting the game with a controller stays windowed
   * whatever this says. That is a browser rule, not a decision.
   */
  autoFullscreen: boolean;
  /**
   * Display language, as an ISO 639-1 code — or null for "whatever the browser
   * asks for", which is the shipped default and NOT the same as 'en'.
   *
   * The distinction is the whole reason this is nullable. A Swedish player who
   * has never opened Settings gets Swedish from `navigator.language`; if the
   * default were the string 'en' instead, that same player would be pinned to
   * English by a preference they never expressed. Only picking a language in the
   * menu writes this, and from then on it outranks the browser — which is what
   * someone who chose English on a Swedish machine expects.
   *
   * Validated by i18n/index.ts against the languages that actually exist, not
   * here: this module has no business knowing which codes ship.
   */
  lang: string | null;
}

export const DEFAULT_PREFS: Readonly<Prefs> = {
  hapticFeedback: true,
  hapticIntensity: 1,
  shakeIntensity: 1,
  volume: 0.8,
  invertLookX: false,
  invertLookY: true,
  autoFullscreen: true,
  lang: null,
};

/**
 * Where each preference lives, and the ONLY place a storage key is spelled out.
 *
 * The field name and the key are deliberately allowed to differ — `lang` is
 * stored as `…gameplay.language`, because the field is code that is typed a
 * hundred times and the key is a name a player might read in devtools. That
 * mapping lives here and nowhere else, which is also what makes the migration
 * below a loop rather than a list of special cases.
 *
 * A field's GROUP is the panel it belongs to, not the module that reads it:
 * camera shake is a graphics setting even though it arrives through the same
 * feedback system as rumble, because that is where a player would look for it.
 */
export const STORAGE_KEYS: Readonly<Record<keyof Prefs, string>> = {
  hapticFeedback: 'game.settings.controls.hapticFeedback',
  hapticIntensity: 'game.settings.controls.hapticIntensity',
  invertLookX: 'game.settings.controls.invertLookX',
  invertLookY: 'game.settings.controls.invertLookY',
  shakeIntensity: 'game.settings.graphics.shakeIntensity',
  autoFullscreen: 'game.settings.graphics.autoFullscreen',
  volume: 'game.settings.gameplay.volume',
  lang: 'game.settings.gameplay.language',
};

/** The pre-migration blob. Read once, then removed. See `migrate`. */
const LEGACY_KEY = 'bs:prefs';

/**
 * Clamp one stored number into 0..1, falling back to the default.
 *
 * EVERY field goes through this, and it is not defensive decoration. Stored
 * values are user-writable text: a hand edit, a half-completed write, or a
 * value left behind by an older build can all put a word or an empty string in
 * here, and `NaN` propagates silently through the haptics mixer all the way to
 * `playEffect`, where a magnitude outside 0..1 is a rejected promise per frame
 * rather than a visible failure. Validating on READ rather than on write also
 * means a value written by a future version with a wider range cannot peg a
 * motor on an older one.
 *
 * `Number('')` is 0, not NaN, which would turn a key someone had blanked into a
 * silent zero — so an empty string is rejected before the conversion.
 */
function num01(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/**
 * Same discipline for the booleans.
 *
 * Exactly `'true'` or `'false'`, not a truthiness test: every other string —
 * `'0'`, `''`, `'off'` — is truthy in JS, and one of those left in a key by a
 * hand edit would silently turn a setting ON for someone who had turned it off.
 * Anything that is not one of the two spellings this module writes falls back
 * to the default.
 */
function bool(raw: string | null, fallback: boolean): boolean {
  return raw === 'true' ? true : raw === 'false' ? false : fallback;
}

/**
 * And for the language code. Shape only — a short lower-case ASCII word — since
 * whether the code names a language that SHIPS is i18n's question, and it
 * already answers it on read (an unknown code falls through to the browser).
 * The length cap is what stops a hand-edited value putting a kilobyte in here.
 */
function langCode(raw: string | null): string | null {
  return raw !== null && /^[a-z]{2,3}$/.test(raw) ? raw : null;
}

function read(field: keyof Prefs): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEYS[field]);
  } catch {
    return null;   // storage denied: every field falls back to its default
  }
}

/** Write one setting, or remove it when the value is "no preference" (null). */
function write(field: keyof Prefs, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEYS[field]);
    else window.localStorage.setItem(STORAGE_KEYS[field], value);
  } catch {
    /* private mode: the choice just does not persist past this session */
  }
}

let migrated = false;

/**
 * Move a pre-existing `bs:prefs` blob into the per-setting keys, once.
 *
 * Everything a player had already tuned — including the language they picked,
 * which is the one whose loss they would notice on the very next load — is
 * carried across by name, through the same `STORAGE_KEYS` map the rest of the
 * module uses, so there is no second spelling of a key to keep in step.
 *
 * A field already present in the new storage is NOT overwritten. That is what
 * makes this safe to run against a half-migrated state: a second tab that has
 * already written the new key holds the newer value, and the blob is by
 * definition the older one.
 *
 * The blob is removed at the end. Leaving it would mean a player who edits a
 * setting today and clears the new keys tomorrow silently gets last year's
 * value back, and keeping two sources of truth for the same setting is exactly
 * what this change was for.
 */
function migrate(): void {
  if (migrated) return;
  migrated = true;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEGACY_KEY);
  } catch {
    return;   // storage denied: nothing to migrate, and nothing to lose
  }
  if (!raw) return;
  try {
    const blob = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    for (const field of Object.keys(STORAGE_KEYS) as Array<keyof Prefs>) {
      const v = blob[field];
      if (v === undefined || v === null) continue;
      if (read(field) !== null) continue;   // the new key already wins
      // The blob's own values were never validated on write either, so they go
      // through the same parsers as anything else — a garbage entry migrates
      // to nothing at all, which lands the field on its default.
      if (field === 'lang') {
        const c = typeof v === 'string' ? langCode(v) : null;
        if (c) write(field, c);
      } else if (typeof DEFAULT_PREFS[field] === 'boolean') {
        if (typeof v === 'boolean') write(field, String(v));
      } else if (typeof v === 'number' && Number.isFinite(v)) {
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
    hapticFeedback: bool(read('hapticFeedback'), DEFAULT_PREFS.hapticFeedback),
    hapticIntensity: num01(read('hapticIntensity'), DEFAULT_PREFS.hapticIntensity),
    shakeIntensity: num01(read('shakeIntensity'), DEFAULT_PREFS.shakeIntensity),
    volume: num01(read('volume'), DEFAULT_PREFS.volume),
    invertLookX: bool(read('invertLookX'), DEFAULT_PREFS.invertLookX),
    invertLookY: bool(read('invertLookY'), DEFAULT_PREFS.invertLookY),
    autoFullscreen: bool(read('autoFullscreen'), DEFAULT_PREFS.autoFullscreen),
    lang: langCode(read('lang')),
  };
}

/**
 * Write the changed settings and report the whole set back.
 *
 * Only the fields named in `patch` are touched — that is the point of the key
 * per setting, and it is why two tabs can each change something without either
 * one writing the other's value back. The re-read at the end is deliberate: the
 * caller gets what STORAGE now says, already clamped and parsed, rather than
 * the raw patch it handed in.
 */
export function savePrefs(patch: Partial<Prefs>): Prefs {
  migrate();   // never write a new key over a blob that has not been read yet
  for (const field of Object.keys(patch) as Array<keyof Prefs>) {
    const v = patch[field];
    if (v === undefined) continue;
    write(field, v === null ? null : String(v));
  }
  return loadPrefs();
}
