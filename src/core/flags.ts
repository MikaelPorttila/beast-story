/**
 * Diagnostic toggles, read once from the URL.
 *
 * These exist to answer "what is this costing?" the only way that survives
 * argument: remove one thing, measure, put it back. post.ts already does this
 * for the render chain (`post=0`, `ao=`, `bloom=`); this is the same idea for
 * the world's contents and the actors in it.
 *
 *   props=0     no trees/boulders/grass in streamed chunks
 *   clouds=0    no cloud deck
 *   water=0     no water surface meshes
 *   enemies=0   no wild spawns
 *   beasts=0    no beast actors at all (nothing built, nothing updated)
 *   shadows=0   no shadow map
 *   shadowcache=0
 *               the shadow map is redrawn from every caster in the world, every
 *               frame, the way it was before core/shadow-cache.ts. Keeps the
 *               shadows themselves, so it is the honest A/B for "is the cache
 *               free": the same picture, from the same casters, with the only
 *               difference being whether the static half was redrawn. That is
 *               the pair tools/test-shadowcache.mjs measures, in both
 *               directions — the frame it saves AND the pixels it must not
 *               change. Deliberately NOT in `anyFlagSet` below, and that is a
 *               CLAIM rather than an oversight: this flag is the one toggle in
 *               the file that must not move a pixel, and the guard photographs
 *               both settings to hold it to that.
 *   towns=0     no settlements and no roads — the world before world/towns.ts.
 *               The terrain corridor goes with them, so this also prices what
 *               the road field costs `heightCont` on the collision hot path.
 *   solids=0    settlements are still BUILT but stop blocking movement — the
 *               world before world/structures.ts, where you walked through the
 *               huts. Keeps the meshes, so it is the honest A/B for "does the
 *               collision do anything": the same walk, into the same wall, with
 *               the only difference being whether the wall is there.
 *   sway=0      grass never waves and never reacts to anything walking or
 *               flying through it — the meadow as static geometry, which is
 *               also the A/B world/sway.ts is verified against.
 *   aim=0       the sword swings exactly where the hero faces, with no melee
 *               aim assist steering it onto the enemy nearest the crosshair.
 *               Same shape as `solids=0`: the enemies, the reach and the arc
 *               are all still there, and the only difference is whether the
 *               swing is allowed to be helped onto one. That is the A/B
 *               tools/test-aim-assist.mjs measures.
 *   view=<n>    chunk streaming radius, in chunks (default 5)
 *   haptics=<n> 0..1, controller rumble strength; 0 issues no effect at all
 *   shake=<n>   0..1, camera-shake strength
 *   invx=<0|1>  invert the controller's horizontal look axis
 *   invy=<0|1>  invert the controller's vertical look axis (default on)
 *   fs=<0|1>    go fullscreen on New Game (default on)
 *   vol=<n>     0..1, music volume; 0 loads no track at all (see below)
 *
 * Those six OVERRIDE the stored player preference (see core/prefs.ts) for this
 * load only, and never write it back. Resolution is always
 * `flag ?? pref ?? default`. They are still diagnostics by the definition
 * above — `haptics=0` is how you prove a rumble came from the cue you think it
 * did, `shake=0` is how you tell a camera problem from a shake problem, and
 * `invy=0` is how tools/test-gamepad.mjs asserts the inversion is a real switch
 * rather than a constant — but they are the first that shadow something the
 * player chose, so the direction matters: a measurement run can pin a value,
 * and cannot corrupt one.
 *
 * Note `invx`/`invy` are TRI-STATE and do not use `on()` below. `on()` reads a
 * missing parameter as true, which is right for a feature that defaults on and
 * wrong here: "absent" has to mean "whatever the player chose", not "inverted".
 *
 * They are diagnostics, not game settings: nothing outside a measurement run
 * should be setting them, and no gameplay code should branch on them beyond the
 * construction points below.
 */
const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

const on = (key: string): boolean => p.get(key) !== '0';

/**
 * A 0/1 override, or null when the parameter is absent.
 *
 * Tri-state, unlike `on()`: null means "defer to the stored preference".
 */
const tri = (key: string): boolean | null => {
  const raw = p.get(key);
  return raw === null ? null : raw !== '0';
};

/** A 0..1 override, or null when the parameter is absent or not a number. */
const unit = (key: string): number | null => {
  const raw = p.get(key);
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

export const flags = {
  props: on('props'),
  clouds: on('clouds'),
  water: on('water'),
  enemies: on('enemies'),
  beasts: on('beasts'),
  shadows: on('shadows'),
  shadowCache: on('shadowcache'),
  towns: on('towns'),
  solids: on('solids'),
  sway: on('sway'),
  aimAssist: on('aim'),
  /** Streaming radius in chunks; null means "use the module default". */
  viewRadius: p.get('view') !== null ? Math.max(1, Number(p.get('view'))) : null,
  /** Feedback and look overrides; null means "use the stored preference". */
  haptics: unit('haptics'),
  shake: unit('shake'),
  invertLookX: tri('invx'),
  invertLookY: tri('invy'),
  /**
   * `fs=<0|1>` — go fullscreen on New Game, overriding the stored preference for
   * this load. Tri-state like the two above, and it earns its place for the same
   * reason `shake` does: a tool that clicks New Game would otherwise have the
   * viewport resized under a measurement it is halfway through taking. Every
   * probe in `tools/` that starts a game passes `fs=0`.
   */
  autoFullscreen: tri('fs'),
  /**
   * `vol=<0..1>` — music volume for this load, overriding the stored preference
   * and never writing it back. Same tri-state shape as `haptics` and `shake`,
   * and `vol=0` is stronger than a mute: `MusicDirector` constructs no element
   * and issues no request at all (see src/audio/music.ts).
   */
  volume: unit('vol'),
  /**
   * A boot NOBODY IS LISTENING TO — a probe or a staged capture — which is what
   * makes silence the right default for it rather than the player's 80%.
   *
   * FOUR MARKERS, and each is one no player's URL carries. `menu=0` is the
   * probe flag (every tool in tools/ passes it), `photo=1` is the capture flag,
   * `fs=0` is what a probe that CLICKS New Game passes so the viewport is not
   * resized under its measurement, and `fps=` is how a capture pins a cadence.
   * Between them they cover every URL in tools/, which is the point: a rule that
   * only covered `menu=0` would leave the staged-boot arms of test-menu,
   * test-pause and test-keybinds streaming a song into a headless browser.
   *
   * `vol=` is how a change that DOES need audio turns it back on — `vol=0.01` is
   * the one AGENTS.md recommends, loud enough for `__dbgMusic()` to prove the
   * element is playing and quiet enough not to startle whoever is at the
   * keyboard. It is checked FIRST wherever this is read, so an explicit volume
   * always beats the inference.
   *
   * Doing it here rather than in each tool's URL is the difference between a
   * rule and a wish: there are twenty probes, and the twenty-first would be
   * written by copying one that has the parameter or one that does not.
   */
  silentBoot: p.get('menu') === '0' || p.get('photo') === '1'
    || p.get('fs') === '0' || p.get('fps') !== null,
  /**
   * `nostore=1` — RUN WITHOUT PERSISTENCE. The save system (core/saves.ts)
   * opens no database, lists nothing, writes nothing, and autosave never arms.
   *
   * A sandbox switch first and a test switch second, and it is the same need
   * both times: a run that must not leave a mark. A probe measuring something
   * else has no business creating save records on the machine it runs on, and
   * an autosave landing mid-measurement is a write, a promise and a stall
   * inside a frame somebody is timing. So the shared probe boot passes it and
   * only tools/test-saves.mjs leaves it off — the same division `menu=0` has,
   * where the flag is the default for everyone who is not testing the thing it
   * turns off.
   *
   * Spelled the other way round from the toggles above (`on('props')` reads a
   * MISSING parameter as true) because this one defaults OFF: persistence is
   * what a player gets, and turning it off has to be asked for explicitly.
   */
  noStore: p.get('nostore') === '1',
  /**
   * `mounts=all` / `mounts=ground,water` — START WITH THESE MOUNTS UNLOCKED.
   *
   * Null (nothing unlocked) unless asked for, because that is what a new
   * character has: riding is three story unlocks, one per act, and
   * `MountUnlocks` is empty until one of them lands.
   *
   * It is here rather than only on the F3 panel for the reason `fs=0` is: a
   * probe that wants to MEASURE a ride should not have to drive the unlock
   * first, key edge by key edge. Every tool in `tools/` that mounts something
   * passes it, and tools/test-mounts.mjs is the one that deliberately does not —
   * it is testing the lock.
   *
   * The words are passed through UNRESOLVED — `all` included — because this
   * file has no imports and is meant to keep none: it sits at the bottom of the
   * dependency graph, and knowing what the kinds ARE would put `core/types.ts`
   * underneath it. main.ts expands `all` against `MOUNT_KINDS` and
   * `MountUnlocks.restore` drops anything else, so `mounts=hovercraft` unlocks
   * nothing rather than needing a second opinion here.
   */
  mounts: p.get('mounts')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null,
  /**
   * Staged-capture mode. NOT a diagnostic toggle like the rest of this file —
   * it lives here because two modules now need the same answer: main.ts, which
   * drives the camera and stands the HUD and the touch overlay down, and
   * world/sway.ts, which freezes the wind clock so a still of a moving meadow
   * is reproducible from run to run.
   */
  photo: p.get('photo') === '1',
  /**
   * `npct=<seconds>` — PIN the NPC animation clock, so a staged capture of
   * someone mid-movement is reproducible. Null (the world's own clock) unless
   * asked for, and never set in play.
   *
   * Same idea as sway.ts freezing the wind clock under `photo=1`, and needed
   * for the same reason: Gain's curl is a 4.6 s loop, so which part of it a
   * still catches otherwise depends on how long the browser took to boot. It
   * pins a PHASE rather than freezing, because the interesting captures are two
   * poses of the same loop — `npct=0` is the weight at his hip and `npct=1.5`
   * is the top of the rep. Not gated on `photo=1`: the shots that matter are
   * the ones the hero walks into, which are not photo-mode shots.
   */
  npcTime: p.get('npct') !== null ? Number(p.get('npct')) : null,
};

/**
 * True when any toggle is off its default — used to keep captures honest.
 *
 * `shake` counts because it moves the camera and therefore the pixels; `haptics`
 * does not, because no setting of it can change a frame.
 */
export const anyFlagSet = (): boolean =>
  !flags.props || !flags.clouds || !flags.water || !flags.enemies
  || !flags.beasts || !flags.shadows || !flags.towns || !flags.solids
  || !flags.sway || !flags.aimAssist
  || flags.viewRadius !== null || flags.shake !== null;
