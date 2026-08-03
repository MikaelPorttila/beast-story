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
 *
 * Those five OVERRIDE the stored player preference (see core/prefs.ts) for this
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
