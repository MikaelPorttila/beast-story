/**
 * Diagnostic toggles, read once from the URL. The table is in AGENTS.md.
 *
 * Preference overrides (haptics, shake, invx, invy, fs, vol) apply to this load only
 * and never write back: resolution is `flag ?? pref ?? default`.
 * Nothing outside a measurement run should set any of these.
 */
const p = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

const on = (key: string): boolean => p.get(key) !== "0";

/** Tri-state, unlike `on()`: null means "defer to the stored preference". */
const tri = (key: string): boolean | null => {
  const raw = p.get(key);
  return raw === null ? null : raw !== "0";
};

/** A 0..1 override, or null when the parameter is absent or not a number. */
const unit = (key: string): number | null => {
  const raw = p.get(key);
  if (raw === null) {
    return null;
  }
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

export const flags = {
  props: on("props"),
  clouds: on("clouds"),
  water: on("water"),
  enemies: on("enemies"),
  beasts: on("beasts"),
  shadows: on("shadows"),
  shadowCache: on("shadowcache"),
  towns: on("towns"),
  /** The hovering shard clusters over the whole world (world/sky-shards.ts). */
  shards: on("shards"),
  solids: on("solids"),
  sway: on("sway"),
  aimAssist: on("aim"),
  /** Streaming radius in chunks; null means "use the module default". */
  viewRadius: p.get("view") !== null ? Math.max(1, Number(p.get("view"))) : null,
  /** Feedback and look overrides; null means "use the stored preference". */
  haptics: unit("haptics"),
  shake: unit("shake"),
  invertLookX: tri("invx"),
  invertLookY: tri("invy"),
  autoFullscreen: tri("fs"),
  /** `vol=0` is stronger than a mute: `MusicDirector` constructs no element at all. */
  volume: unit("vol"),
  /**
   * A boot nobody is listening to. The four markers cover every URL in tools/;
   * an explicit `vol=` is checked FIRST wherever this is read and beats the inference.
   */
  silentBoot:
    p.get("menu") === "0" || p.get("photo") === "1" || p.get("fs") === "0" || p.get("fps") !== null,
  /** `nostore=1` — core/saves.ts opens no database and autosave never arms. Defaults OFF. */
  noStore: p.get("nostore") === "1",
  /**
   * `debug=1` — the developer's game: F3 and the `§` console reachable, F3 on the F1 sheet,
   * a new game bonded to the starter. A player's new game has none of these. Defaults OFF.
   */
  debug: p.get("debug") === "1",
  /**
   * `mounts=all` / `mounts=ground,water`. Words stay UNRESOLVED so this file keeps no
   * imports; main.ts expands `all` and `MountUnlocks.restore` drops what it cannot match.
   */
  mounts:
    p
      .get("mounts")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null,
  /** Staged capture. Read by main.ts and by world/sway.ts, which freezes the wind clock. */
  photo: p.get("photo") === "1",
  /** `npct=<seconds>` pins the NPC animation phase so a capture is reproducible. */
  npcTime: p.get("npct") !== null ? Number(p.get("npct")) : null,
};

/**
 * True when any toggle is off its default — keeps captures honest. `shake` counts
 * (it moves pixels); `haptics` and `shadowcache` cannot change a frame, so they do not.
 */
export const anyFlagSet = (): boolean =>
  !flags.props ||
  !flags.clouds ||
  !flags.water ||
  !flags.enemies ||
  !flags.beasts ||
  !flags.shadows ||
  !flags.towns ||
  !flags.solids ||
  !flags.sway ||
  !flags.aimAssist ||
  flags.viewRadius !== null ||
  flags.shake !== null;
