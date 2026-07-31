/**
 * Player preferences that OUTLIVE a session.
 *
 * Distinct from core/flags.ts, which is the diagnostic layer: a flag answers
 * "what is this costing?" for one measurement run and is never set in play,
 * while this is what a player chose and expects to still be true tomorrow.
 * Where both have an opinion, the URL wins — see `resolve`.
 *
 * PERSISTENCE follows ui/fullscreen.ts, which already owns the only other
 * localStorage key in the game and already established the shape: a `cp:`
 * prefix so a later save system can share it, and try/catch on BOTH sides
 * because localStorage throws outright in some private-browsing modes. A
 * failure degrades to defaults, which is the harmless direction — the player
 * gets the stock feel rather than an exception out of a constructor.
 *
 * One blob rather than a key per field, unlike the fullscreen answer. That one
 * is a single gate with its own lifetime; these are a set that is read once at
 * boot and written together whenever one changes.
 */

export interface Prefs {
  /** Rumble strength, 0..1. 0 means the haptics channel issues nothing at all. */
  hapticIntensity: number;
  /** Camera-shake strength, 0..1, scaling the tuned per-cue amounts. */
  shakeIntensity: number;
  /**
   * Reserved for src/feedback/audio.ts, which is a seam with no sound behind it
   * yet. Stored now so that the day audio lands it does not silently start at
   * full volume for everyone who had already tuned the other two.
   */
  volume: number;
}

export const DEFAULT_PREFS: Readonly<Prefs> = {
  hapticIntensity: 1,
  shakeIntensity: 1,
  volume: 0.8,
};

const STORAGE_KEY = 'cp:prefs';

/**
 * Clamp one stored number into 0..1, falling back to the default.
 *
 * EVERY field goes through this, and it is not defensive decoration. The stored
 * blob is user-writable text: a hand-edited file, a half-completed write, or a
 * value left behind by an older build can all put a string or a NaN in here, and
 * `NaN` propagates silently through the haptics mixer all the way to
 * `playEffect`, where a magnitude outside 0..1 is a rejected promise per frame
 * rather than a visible failure. Validating on READ rather than on write also
 * means a blob written by a future version with a wider range cannot peg a
 * motor on an older one.
 */
function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : fallback;
}

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const o = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    return {
      hapticIntensity: clamp01(o.hapticIntensity, DEFAULT_PREFS.hapticIntensity),
      shakeIntensity: clamp01(o.shakeIntensity, DEFAULT_PREFS.shakeIntensity),
      volume: clamp01(o.volume, DEFAULT_PREFS.volume),
    };
  } catch {
    // Unreadable, unparseable, or storage denied: the stock feel.
    return { ...DEFAULT_PREFS };
  }
}

/** Merge a change into the stored blob. Silently a no-op where storage is denied. */
export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice just does not persist past this session */
  }
  return next;
}
