import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Gfx, GFX_OPTIONS, type GfxSinks } from './core/gfx';
import { PerfPanel } from './ui/perf-panel';
import { Cursors, CursorDirector, CURSOR_STATES, type CursorState } from './ui/cursor';
import { Input } from './core/input';
import { TouchControls, isTouchPrimary } from './core/touch';
import { installViewport } from './core/viewport';
import { GamepadControls, type LookAxes } from './core/gamepad';
import { FeedbackSystem } from './feedback';
import { loadPrefs, savePrefs } from './core/prefs';
import {
  EventBus,
  type CrownContact, type NpcInfo, type SkillDef, type Damageable,
  type World, type WorldBound,
} from './core/types';
import { Inventory, itemDef, itemName } from './core/items';
import { t, onLanguageChange } from './i18n';
import { perf } from './core/profiler';
import { flags } from './core/flags';
import { DevConsole } from './ui/console';
import { ColliderView } from './core/collider-view';
import { createWorld, type LandmarkProbe } from './world/index';
import { NPC_TALK_RANGE } from './world/npc';
import { createDungeon } from './world/dungeon';
import { ZoneManager, type ZoneDef } from './world/zones';
import { Underwater } from './world/underwater';
import { TouchParticles } from './world/touch-particles';
import { Player } from './player/index';
import { MountController } from './player/mount';
import { BeastActor, registerSkillDefs } from './beasts/framework';
import { CombatSystem, SWORD_REACH } from './combat/index';
import { HUD, type BeastHudInfo, type ShopOffer, type SkillSlot } from './ui/index';
import { StartMenu } from './ui/menu';
import { PauseMenu } from './ui/pause';
import { exitFullscreen } from './ui/fullscreen';
import { LoadingScreen } from './ui/loading';
import { ALL_SPECIES, SKILLS, getSkill } from './beasts/registry';

const app = document.getElementById('app')!;
// BEFORE the engine, and before anything else measures itself: #app is sized
// from the custom properties this publishes, and the renderer takes its first
// size from #app. See src/core/viewport.ts for why the viewport is measured
// rather than asked for in dvh.
installViewport();
const engine = new Engine(app);
const input = new Input(engine.renderer.domElement);
const bus = new EventBus();

// ---------------------------------------------------------------------------
// BOOT ORDER, and why this module now has `await` in it.
//
// Everything below used to run in ONE unbroken task. Measured on the dev server
// at 1280x800 with a long-task observer installed ahead of this module: a single
// 14702 ms task starting at 140 ms, and first contentful paint at 15312 ms. For
// fifteen seconds there was nothing on screen at all — no title screen, no
// canvas, no spinner — because `createWorld` cut two towns and their roads, ten
// beast rigs were built, and the whole shader warm-up sweep ran, all before the
// browser was handed a single frame. Then the game LOOP started, and went on
// simulating and drawing the world behind the poster, capped to 20 fps, for as
// long as the player left the title screen up.
//
// The same load now has the title screen up at 221 ms (`menuShownAtMs` in
// tools/test-menu.mjs), and reports the rest — 602 ms of world, 85 ms of actors,
// 13477 ms of shader warm-up, 1193 ms of streaming — on a progress chip in the
// corner of it. Nothing got faster; the player simply stopped being made to wait
// in the dark for it.
//
// So the boot is now three named things instead of one:
//
//   1. THE POSTER GOES UP FIRST. The title screen and the progress chip are
//      built here, out of nothing but the DOM, and the module then yields. They
//      are on screen within a frame of the module being evaluated.
//   2. THE GAME IS BUILT IN PHASES, each announced on the chip and each
//      separated from the next by a real paint (see LoadingScreen.stage). The
//      world, the actors, the shaders and the streaming ring, in that order.
//      This is the only work happening while the menu is up.
//   3. NOTHING RENDERS UNTIL THERE IS A PLAYER. `frame()` is called by
//      `beginPlay()` and by nothing else. Preparation drives its own renders —
//      the warm-up sweep IS a render, that is what compiles a shader — and once
//      it is done the main thread goes quiet until New Game is pressed. The old
//      MENU_FPS cap that made a 96.9% main thread into a 27% one is gone with
//      it: the honest figure for an idle title screen is now neither, it is the
//      CSS on the poster.
//
// The menu is LIVE throughout phase 2, which is the one thing this arrangement
// costs. Its hooks can therefore fire before the systems they talk to exist —
// hence the two `let`s below rather than the `const`s further down, and hence
// `beginPlay()` being gated on `prepDone` rather than trusting the timing.
// ---------------------------------------------------------------------------

/**
 * The pad and the feedback mixer, ASSIGNED further down where their
 * dependencies exist.
 *
 * `let ... = null` rather than the `const`s they used to be, and the reason is
 * the boot order above: the title screen's Settings panel is usable while the
 * game is still being built, so `onLookAxes` and `onHapticFeedback` can be
 * called before either of these has been constructed. A `const` declared later
 * in the module would be in its temporal dead zone at that moment and the hook
 * would THROW rather than harmlessly do nothing. Null is the right answer for
 * "not built yet": the menu has already persisted the choice, and both are
 * constructed from `loadPrefs()` below, so the switch is honoured either way.
 */
let pad: GamepadControls | null = null;
let feedback: FeedbackSystem | null = null;

/** True once every boot phase has finished; nothing may start playing before. */
let prepDone = false;
/** True once the title screen has handed over (or there was never one). */
let handedOver = false;
/** True once `frame()` is running. */
let playing = false;

/**
 * What a settings panel does to the running game, wherever it is shown from.
 *
 * ONE object for both screens, because there is one settings list (ui/settings.ts)
 * and these are what it does — a second copy for the in-game menu would be two
 * places to remember when a switch grows a third effect.
 *
 * Straight through to the pad and the feedback mixer, both of which take a change
 * at any time by design. The preference itself is saved by the panel, so a change
 * thrown before either exists — which the title screen's can be, see the boot
 * order above — is picked up when it is built.
 */
const settingsHooks = {
  onLookAxes: (a: Partial<LookAxes>) => pad?.setLookAxes(a),
  onHapticFeedback: (on: boolean) => feedback?.setOptions({ hapticFeedback: on }),
};

/**
 * The title screen. Reassignable, because Exit raises a NEW one — the poster is
 * built, faded in and taken off the DOM by its own lifecycle, and the way back
 * to it is another instance rather than a hidden one kept around all session.
 */
let startMenu = StartMenu.offer({
  ...settingsHooks,
  // The poster has begun dissolving, which is the moment what is behind it
  // starts being seen. Behind it is the loading screen, raised here so the
  // menu's own half-second fade is the transition INTO it — see
  // LoadingScreen.cover for why that needs no cross-fade of its own.
  onLeave: () => loading?.cover(),
  onStart: () => { handedOver = true; beginPlay(); },
});

/**
 * True when the boot is STAGED behind a title screen — the only case that wants
 * a progress indicator, real paints between phases, and a game that waits.
 *
 * False for the two cases that must keep booting exactly as they did:
 *   - `menu=0`, which every probe in `tools/` passes. They drive the hero within
 *     a second of `load` and several read `__dbgPlayerPos` immediately; a boot
 *     that spent ten frames yielding, or that held the frame loop back until the
 *     streaming ring was full, would change what every one of them measures.
 *   - `photo=1`, including `photo=1&menu=1` where the menu IS the subject of the
 *     capture. A progress chip in the corner of a staged still is a bug.
 */
const staged = startMenu !== null && !flags.photo;
const loading = staged ? new LoadingScreen() : null;
if (!staged) handedOver = true;

/**
 * Start the game, once BOTH halves are true: everything is built, and the
 * player has asked for it.
 *
 * Two callers — the end of the boot sequence and the menu's `onStart` — and
 * whichever is last wins. That is the whole handshake, and it is a handshake
 * rather than a sequence because the two events genuinely race: a player who
 * clicks New Game while the shader sweep is still running has asked first, and
 * a player who reads the title screen for a minute has asked last.
 *
 * The `prepDone` guard is also what makes the body safe to write against
 * consts declared hundreds of lines below — `fpsCap`, `staged`, `hud`'s bus
 * listener. `prepDone` is set on the last line of the boot sequence, so by the
 * time any of this runs the whole module has been evaluated. Reorder that and
 * the first thing you get is a temporal-dead-zone throw inside a click handler.
 */
function beginPlay(): void {
  if (playing || !prepDone || !handedOver) return;
  playing = true;
  // Every key pressed at the title screen is still latched in `Input` — nothing
  // has drained it, because `endFrame()` only runs inside `frame()` and
  // `frame()` has not run yet. Unread, the first simulation slice would see the
  // whole menu session at once: the Enter that started the game, the arrow keys
  // that walked the list, the `E` somebody idly pressed. Drain it here, and the
  // hero wakes up to an empty keyboard.
  input.endFrame();
  loading?.finish();
  // Everything the F3 panel owns, pushed at the freshly built world — the frame
  // cap among it, which is why this replaced a bare `engine.setFpsCap(fpsCap)`
  // here. That line re-applied the URL/default cap on every New Game and would
  // have quietly undone a player's stored choice a moment after loading it.
  gfx.applyAll();
  if (staged) {
    // TAKE THE POINTER HERE, not on the player's first click in the world. New
    // Game is a click on a BUTTON — the canvas never sees a mousedown — so
    // without this the game opens with a cursor sitting over it and mouse look
    // dead until you click, which is the same "why is it deaf?" the controls
    // sheet used to cause on the way out. Touch is left alone: there is no
    // pointer to lock and the overlay is the control scheme.
    //
    // Best-effort by construction (see `Input.requestLock`). A browser only
    // grants this off a recent user activation, and while the New Game click is
    // one, a machine slow enough to spend more than a few seconds on the boot
    // after it will have let that expire — those players click once, as they
    // always did. The unstaged path never asks at all.
    if (!isTouchPrimary()) input.requestLock();
    // Deferred to here rather than emitted when the menu closed: a toast lives
    // about four seconds, and this is the first moment the player is looking at
    // the game rather than at a poster or a loading bar.
    bus.emit({
      type: 'toast',
      // A touchscreen laptop driven by mouse gets the desktop hint: `touch` is
      // non-null there (it ticks the camera stick) but stays hidden until a touch.
      text: t(isTouchPrimary() ? 'toast.welcome.touch' : 'toast.welcome.desktop'),
    });
  }
  frame();
}

/**
 * The in-game menu: Escape, the pad's Start, and the touch overlay's MENU.
 *
 * Built here rather than lazily on the first Escape, because it is the composition
 * root's job to say what a settings switch does and this is the second screen
 * that shows one. It costs nothing until it is opened — `open()` is what puts
 * anything on the DOM.
 */
const pauseMenu = new PauseMenu({
  ...settingsHooks,
  // Mouse look is given BACK on the way in and taken again on the way out. This
  // is the shop's bargain, not the controls sheet's, and the difference is what
  // the player does with each: a sheet is READ and closed with the key that
  // opened it (so keeping the lock saves a click), where this is CLICKED — three
  // buttons and a settings list, with a cursor that has to be able to reach
  // Exit. See the F1 note further down for the other half of the argument.
  onOpen: () => input.releaseLock(),
  onClose: () => { if (!isTouchPrimary()) input.requestLock(); },
  onExit: () => exitToTitle(),
});

/**
 * END THE SESSION and put the title screen back, in the same page.
 *
 * WHAT IS THROWN AWAY AND WHAT IS KEPT, which is the whole design.
 *
 * Thrown away: everything that is a PLAY SESSION. The hero's health and where he
 * is standing, ten beasts' levels, xp and learned skills, the purse, the bag, the
 * wild population, every drop on the ground, the roster picks, the cooldowns, the
 * zone. Each of those is reset by the object that owns it — `Player.reset`,
 * `BeastActor.reset`, `CombatSystem.reset` — rather than by this function
 * reaching into them, so a field added to one of those is reset by the file that
 * added it.
 *
 * Kept: the engine, the world and the rigs. That is a deliberate departure from
 * "dispose everything", and the reason is the boot timings at the top of this
 * file. Rebuilding the world costs 602 ms and re-linking the shader programs that
 * come with it costs 13477 ms — so a New Game after an Exit would sit behind the
 * loading screen for the better part of fifteen seconds, which is the exact cost
 * an in-process return was chosen to avoid. Nothing in a world or a rig is
 * per-session anyway: the terrain, the towns and the roads are pure functions of
 * the seed and identical every game (see world/terrain.ts), and a beast's rig is
 * geometry while its LEVEL is the save game.
 *
 * The seam is here if that trade ever needs revisiting: everything that would
 * have to be disposed is reached from this one function.
 */
function exitToTitle(): void {
  if (!playing) return;
  // Stops the loop at the top of `frame()`. Nothing is torn down under a frame
  // that is halfway through drawing it.
  playing = false;
  // Fullscreen was TAKEN on New Game (ui/menu.ts), so it is given back here:
  // going to the title screen means going back to what you had before you
  // started, and no browser undoes it on its own.
  exitFullscreen();
  input.releaseLock();

  // Back to the overworld first, because the reset below places the hero at
  // `world.spawnPoint` and a player who quit inside the dungeon would otherwise
  // spawn a new game in it. The switch rebinds every `bound` subsystem, which is
  // what makes the following three lines resolve against the right heightfield.
  if (zones.id !== 'overworld') zones.switchTo('overworld');

  player.reset();
  mount.dismount();
  combat.reset();
  for (const b of roster) b.reset();
  primaryIdx = 0;
  supportIdx = 6;
  refreshVisibility();
  cooldowns.clear();
  spent = 0;
  bag.clear();
  fetchScanT = 0;
  nearShop = false;
  nearNpc = null;
  world.npcs?.endTalk();
  hud.closeShop();
  hud.closeControls();
  hud.reset();
  touch?.setVisible(true);

  // The poster is a NEW instance, because the old one took itself off the DOM
  // when the game started (see StartMenu.close). `handedOver` and `playing` go
  // back to what they were before New Game was first pressed, so `beginPlay`'s
  // handshake works a second time exactly as it did the first.
  handedOver = false;
  startMenu = StartMenu.offer({
    ...settingsHooks,
    onLeave: () => loading?.cover(),
    onStart: () => { handedOver = true; beginPlay(); },
  }, { skipSplash: true });
  // `menu=0` and photo mode suppress the menu outright (see StartMenu.offer),
  // and in those runs Exit cannot be reached — there is no menu to press it in.
  // The guard is here so that stays true rather than becoming a black screen if
  // one ever grows a way to.
  if (!startMenu) { handedOver = true; beginPlay(); }
}

// Phase 1 ends here: the poster and the chip are on screen before the first
// chunk exists. Everything past this point is phase 2.
await loading?.stage('world');

// ---------------------------------------------------------------------------
// Zones. There are two: the streamed overworld and one dungeon instance. The
// ZoneManager owns both, preloads the destination while the hero walks toward a
// gateway, and rebinds every subsystem in `bound` on a switch — see
// world/zones.ts for the enter/exit/dwell numbers and why each is what it is.
// Gameplay policy on arrival (where the hero lands, dismounting, the toast) is
// this file's business, so it lives in `onArrive` below.
// ---------------------------------------------------------------------------

/** Offsets probed for level ground under the gateway. */
const GATE_PROBES: ReadonlyArray<readonly [number, number]> =
  [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]];

/**
 * Where the overworld's gateway stands.
 *
 * 34-42 units from spawn, and the lower bound is the load-bearing part: the
 * preload band is 30 units wide, so anything closer would put the hero INSIDE
 * it at spawn and the dungeon would be built during boot whether or not he ever
 * walks that way. Measured at a first-pass 20 units, that is exactly what
 * happened — `__dbgZone().pending` came back fully built and warmed before the
 * player had moved. At 34 the band is entered by walking toward the arch, which
 * is what it is for. The upper bound is just "still a landmark you find by
 * looking around", the first skill den being 18 units out for comparison.
 *
 * Scored on level, dry ground clear of the dens: the arch is 5 units tall with
 * pillars 4.6 apart, and half of it buried in a hillside or clipping a pagoda
 * reads as a bug rather than as a landmark.
 */
function findGateSpot(w: LandmarkProbe): { x: number; z: number } {
  const base = w.spawnPoint;
  let best = { x: base.x + 34.5, z: base.z + 0.5 };
  let bestScore = Infinity;
  for (const radius of [34, 38, 31, 42]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + 0.9;
      const x = Math.round(base.x + Math.cos(a) * radius) + 0.5;
      const z = Math.round(base.z + Math.sin(a) * radius) + 0.5;
      const h = w.getHeight(x, z);
      if (h < w.waterLevel + 1) continue;
      let worst = 0;
      for (const [dx, dz] of GATE_PROBES) {
        worst = Math.max(worst, Math.abs(w.getHeight(x + dx, z + dz) - h));
      }
      let shopPenalty = 0;
      for (const s of w.shopPositions) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 12) shopPenalty += 12 - d;
      }
      // A town is a far bigger object than a den, so its penalty is its own
      // footprint plus the arch's clearance rather than a fixed 12.
      for (const t of w.towns.all) {
        const keep = t.radius + 10;
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < keep) shopPenalty += (keep - d) * 3;
      }
      const score = worst * 3 + shopPenalty;
      if (score < bestScore) { bestScore = score; best = { x, z }; }
      if (score === 0) return best;
    }
  }
  return best;
}

/**
 * Chosen inside createWorld (so the terrain can be flattened and the props kept
 * off it) and read back by `gate` a moment later. A module-level handoff rather
 * than running the search twice: it is a scan over a few hundred columns, and
 * two runs of it would be two chances to disagree.
 */
let gateSite: { x: number; z: number } | null = null;

// The zone ID is the identifier — 'overworld' is what ZoneManager, the gate
// targets and `/zone <id>` all key on, and it does not change. Only `name` is
// display, so it comes out of the string table.
//
// A GETTER, not a stored string, and that is the point: the start menu can
// change the language after these objects are built, and a name captured at
// load would put "Embervale" in a Swedish arrival toast forever. `name` is read
// when a zone is entered — twice a session, not per frame — so looking it up at
// each read costs nothing and cannot go stale. The zones are the only load-time
// strings that get this treatment rather than the `onLanguageChange` re-derive
// below, because they are the only ones behind an interface someone else owns.
const OVERWORLD: ZoneDef = {
  id: 'overworld',
  get name() { return t('zone.overworld.name'); },
  create: (scene) => createWorld(scene, 1337, (probe) => {
    gateSite = findGateSpot(probe);
    return [gateSite];
  }),
  gate: () => ({ to: 'hold', x: gateSite!.x, z: gateSite!.z, hex: 0x8be3ff }),
};

const HOLD: ZoneDef = {
  id: 'hold',
  get name() { return t('zone.hold.name'); },
  create: (scene) => createDungeon(scene, 0x5ea1ed),
  // The way out stands on the way in: you arrive on the return gateway, which
  // is exactly why it starts disarmed (see EXIT_R in world/zones.ts).
  gate: (w) => ({ to: 'overworld', x: w.spawnPoint.x, z: w.spawnPoint.z, hex: 0xffc46b }),
};

/** Everything that captured a World at construction; rebound on every switch. */
const bound: WorldBound[] = [];
/** Set by the zone manager each slice; consumed by the HUD hint below. */
let portalHint: string | null = null;

/**
 * The interact prompt, composed at load and again whenever the language or the
 * input device moves under it. Empty until `composeKeyHints()` runs — it needs
 * the HUD, which is built below.
 *
 * The hint pill is HTML and the key cap arrives inside the `{key}` placeholder
 * (see HUD.showHint and `kbd`), so this is a `t(key, vars)` call — which
 * allocates. It is hoisted out of the frame loop for exactly that reason: the
 * loop below runs it every frame the hero is stood near a den. Same argument as
 * SHOP_FOOT_HINTS in src/ui/index.ts.
 *
 * A `let` rather than a `const` because two things can move it: the start menu
 * changing the language, and the player changing device — the cap inside it is
 * `E` on a keyboard and a controller face on a pad. `composeKeyHints()` below is
 * the ONE place that writes it, on both edges. It is still composed a handful of
 * times per session, never per frame.
 */
let skillDenHint = '';

const zones = new ZoneManager({
  scene: engine.scene,
  zones: [OVERWORLD, HOLD],
  start: 'overworld',
  bind: bound,
  warm: (stage, lights) => warmUpFrame(stage, lights),
  onArrive: (w, def) => {
    world = w;
    // A saddle pose is computed against one world's heightfield; applying it in
    // another is precisely the teleport-into-rock this rebinding exists to stop.
    if (mount.isMounted) mount.dismount();
    player.position.copy(w.spawnPoint);
    player.position.y = Math.max(
      w.getHeight(w.spawnPoint.x, w.spawnPoint.z), w.waterLevel,
    );
    player.velocity.set(0, 0, 0);
    // The beasts need no placement: their follow update teleports any beast whose
    // owner is further than TELEPORT_DIST away, and a zone is by construction
    // further than that, so they poof in beside him on the next slice using the
    // new world's ground height.
    bus.emit({ type: 'toast', text: t('toast.enteredZone', { zone: def.name }) });
    // The compass markers are per-zone landmarks, so the set is rebuilt here
    // and nowhere else. `gate` is the ZoneDef's own answer, not a second search.
    const g = def.gate(w);
    syncCompassMarkers(w, g.x, g.z, g.hex);
    // A new zone is new meshes, and a visibility flag set on the old world's
    // chunks went with them. Everything else in gfx is renderer state and
    // survives a switch, but pushing the lot is one call and cannot go stale.
    gfx.applyAll();
  },
  onHint: (t) => { portalHint = t; },
});

// The world is cut. Next the things that stand on it: the hero, the camera, the
// combat pools, the HUD and ten beast rigs.
await loading?.stage('actors');

let world: World = zones.world;
// Submerged-camera treatment. Scene-level and zone-agnostic (it takes the world
// only as a per-frame "is there water under the lens" answer), so it survives a
// zone switch without being in `bound`.
const underwater = new Underwater(engine.scene, engine.camera, engine.renderer.domElement);
const player = new Player(engine, world, input, bus);
const combat = new CombatSystem(engine.scene, world, bus);
const hud = new HUD(bus);

player.position.copy(world.spawnPoint);
player.onAttack = (origin, dir) => combat.meleeStrike(origin, dir, player.attackStat);

/**
 * Melee aim assist: how far off the CROSSHAIR'S BEARING an enemy may sit, as
 * seen from the hero, and still be the one the swing is meant for. cos of the
 * half-angle, so ~75 degrees each side.
 *
 * Chosen against the arc rather than picked for feel. `SWORD_ARC_COS` is ~50
 * degrees each side, so a cone at 50 would be almost inert — an enemy the assist
 * could reach for is one the un-steered swing was about to hit anyway. The
 * interesting band is the ~25 degrees OUTSIDE the arc, where a controller player
 * is plainly aiming at something and plainly missing it, and 75 covers that with
 * a little margin for the hero's heading lagging the camera (`TURN_RATE`) — the
 * body-relative turn can exceed 75 by exactly that lag, which is correct: the
 * assist aims where you are LOOKING, not where the shoulders have caught up to.
 *
 * Wider is wrong in a way worth recording, because the arc is a wedge and not a
 * ray: steering it far enough sweeps the far edge OFF enemies it already
 * covered. Past ~90 the assist starts costing hits in a crowd to buy one.
 */
const AIM_ASSIST_CONE_COS = Math.cos((75 * Math.PI) / 180);
/** Scratch for the crosshair ray below. The strike path allocates nothing. */
const _aimDir = new THREE.Vector3();

/**
 * Steer the sword onto the enemy nearest the crosshair, if one is in reach.
 *
 * Gameplay policy, so it lives in the composition root: the query belongs to
 * combat (it owns the enemies) and the body belongs to the player (it owns the
 * heading), and neither of them should be deciding how generous the game is.
 *
 * Deliberately NOT gated on the input device, though a controller is what asked
 * for it. Aim assist that only exists on one device is a rule players cannot
 * learn — and on a mouse it is close to inert anyway, because a mouse player is
 * already pointing at the thing they mean and `bestMeleeTarget` will just hand
 * back what the arc was going to hit. `?aim=0` turns it off for measurement.
 */
player.aimAssist = (origin, dir) => {
  if (!flags.aimAssist) return false;
  engine.camera.getWorldDirection(_aimDir);
  const target = combat.bestMeleeTarget(origin, _aimDir, SWORD_REACH, AIM_ASSIST_CONE_COS);
  if (!target) return false;
  const dx = target.position.x - origin.x;
  const dz = target.position.z - origin.z;
  const d = Math.hypot(dx, dz);
  // Standing inside the target: there is no bearing to steer onto, and the arc
  // hits it from wherever it swings.
  if (d < 1e-4) return false;
  // Re-point the HORIZONTAL bearing and leave the vertical component alone. In
  // the saddle `dir` is the pitched crosshair ray and its `y` is what lifts the
  // strike origin over the mount's bulk (see MOUNTED_REACH); flattening it here
  // would quietly drop the swing back into the animal's back.
  const horiz = Math.hypot(dir.x, dir.z);
  dir.x = (dx / d) * horiz;
  dir.z = (dz / d) * horiz;
  return true;
};

// ---------------------------------------------------------------------------
// Compass markers. Which landmarks are worth a chip is gameplay policy, so the
// list lives here rather than in the HUD or the world.
//
// Today that is the four skill dens and the zone gateway. Adding one more is a
// single hud.addCompassMarker({ id, x, z, color, label? }) call from wherever
// the thing is created — a town, a quest objective, a downed beast. The id is the
// identity: call it again with the same id to move or recolour the chip, and
// hud.removeCompassMarker(id) when the objective is done.
// ---------------------------------------------------------------------------
function syncCompassMarkers(w: World, gateX: number, gateZ: number, gateHex: number): void {
  hud.setCompassMarkers([
    // Dens in the shard-shop amber the hint pill and price tags already use.
    ...w.shopPositions.map((s, i) => ({ id: `den${i}`, x: s.x, z: s.z, color: 0xffd23f })),
    // TOWNS, straight off the registry — one line, and it is the same list a
    // quest would enumerate. The chip points at the GATE rather than the centre
    // because that is where you actually have to arrive, and it carries the
    // town's own colour so the strip distinguishes them. The label is the first
    // four characters of the id, which is all a chip has room for.
    ...w.towns.all.map((t) => ({
      id: `town:${t.id}`,
      x: t.gateX,
      z: t.gateZ,
      color: t.color,
      label: t.id.slice(0, 4).toUpperCase(),
    })),
    // The gateway takes the colour of its own arch, so the chip and the thing
    // it points at are the same object on screen.
    { id: 'gate', x: gateX, z: gateZ, color: gateHex, label: 'GATE' },
  ]);
}
{
  const g = OVERWORLD.gate(world);
  syncCompassMarkers(world, g.x, g.z, g.hex);
}

// Hold F to ride your beast. The controller owns the hold timer, the refusal
// rules and a mounted beast's locomotion; which beast is offered (the primary, see
// simulate) and where a mounted skill aims (below) are policy, so they live here.
const mount = new MountController(player, world, input, bus);

// Contact particles: the world sheds when you brush it. One element today —
// leaves knocked out of a tree crown — behind a fixed pool and one draw call.
// Constructed HERE, above the frame loop and above warmUpShaders(), because its
// mesh has to be in the scene for the boot warm-up to link its program; a pool
// that first appears when the hero walks into a tree links a shader mid-game,
// which is a several-hundred-millisecond stall (see warmUpShaders).
const touchFx = new TouchParticles(engine.scene, world);

// ---------------------------------------------------------------------------
// Beast roster: all 10 species instantiated; two active at a time.
// ---------------------------------------------------------------------------
registerSkillDefs(SKILLS.values());
const roster: BeastActor[] = ALL_SPECIES.map(
  (sp) => new BeastActor(sp, engine.scene, world, bus),
);
// The rebind list. Order does not matter — every setWorld is independent — but
// the roster is the reason the list exists at all: a beast's level, xp and known
// skills are the save game, and rebuilding one to change zones would delete it.
bound.push(player, mount, combat, touchFx, ...roster);
let primaryIdx = 0; // Emberfox
let supportIdx = 6; // Galebird
const cooldowns = new Map<string, number>();

function primary(): BeastActor { return roster[primaryIdx]; }
function support(): BeastActor { return roster[supportIdx]; }

// `beasts=0` hides the party and skips its per-frame update, so a measurement run
// can price what the two active beasts cost to animate and draw. It does NOT skip
// building the rigs — the roster is still constructed, because half of main.ts
// reads primary()/support() and a null roster would need guards everywhere for
// the sake of a diagnostic. Rig construction is a boot cost; read it off the
// boot phase of a profile instead. See core/flags.ts.
function refreshVisibility(): void {
  roster.forEach((p, i) => p.setVisible(flags.beasts && (i === primaryIdx || i === supportIdx)));
}
refreshVisibility();

function cycleBeast(which: 'primary' | 'support', dirn: 1 | -1): void {
  const n = roster.length;
  if (which === 'primary') {
    do { primaryIdx = (primaryIdx + dirn + n) % n; } while (primaryIdx === supportIdx);
  } else {
    do { supportIdx = (supportIdx + dirn + n) % n; } while (supportIdx === primaryIdx);
  }
  refreshVisibility();
  bus.emit({
    type: 'toast',
    text: t('toast.beastLeads', {
      lead: t(primary().species.nameKey), support: t(support().species.nameKey),
    }),
  });
}

// ---------------------------------------------------------------------------
// Currency (pickups tracked by combat; purchases tracked here)
//
// The item id is 'shard' and the event is `shardsChanged`; the DISPLAY name is
// "Cubloons" and lives in src/i18n/en.ts. The identifiers were left alone on
// purpose — renaming them would rename a save key to change a label.
// ---------------------------------------------------------------------------
let pickupTotal = 50;
let spent = 0;
const shards = () => pickupTotal - spent;

// The bag holds STACKABLES only — currency stays the running total above. Combat
// reports every drop that leaves the ground; what to do with it is policy, so
// it is decided here.
const bag = new Inventory();

bus.on((e) => {
  if (e.type === 'shardsChanged') {
    pickupTotal = e.total;
    hud.setShards(shards());
  }
  if (e.type === 'itemPicked') {
    const def = itemDef(e.itemId);
    if (def.kind !== 'currency') {
      const n = bag.add(e.itemId, 1);
      hud.setBag(bag.entries());
      if (e.byBeast) {
        // The fetcher is whichever beast is carrying right now — normally the
        // support beast, but a Tab swap mid-errand must not misattribute it.
        const fetcher = roster.find((p) => p.isCarrying) ?? support();
        bus.emit({
          type: 'toast',
          text: t('toast.fetched', {
            beast: t(fetcher.species.nameKey), item: itemName(def, n), n,
          }),
        });
      }
    }
  }
  if (e.type === 'enemyKilled') {
    primary().gainXp(e.xp);
    support().gainXp(Math.round(e.xp * 0.6));
  }
});
hud.setShards(shards());

// ---------------------------------------------------------------------------
// Fetch errands (support-beast AI, so it lives here)
// ---------------------------------------------------------------------------
// The rule, in one predicate:
//   currency   — always worth a trip. Money is money.
//   stackable  — only if the player ALREADY holds at least one. The beast tops up
//                stacks you have chosen to carry and leaves everything else on
//                the ground, so a fetcher never fills your bag with things you
//                have never picked up yourself. Walking over an item is how you
//                opt in to it, and from then on the beast collects that kind.
// It is the SUPPORT beast that runs these: the primary stays at the player's
// shoulder where its skills are aimed from.
const FETCH_RADIUS = 16;      // how far from the player a drop may be to be offered
const FETCH_SCAN = 0.4;       // seconds between scans; the pool is small but this is a poll
let fetchScanT = 0;

function worthFetching(itemId: string): boolean {
  const def = itemDef(itemId);
  return def.kind === 'currency' || bag.count(itemId) > 0;
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------
/**
 * Aim for a mounted cast: the camera's own view direction.
 *
 * The crosshair is a DOM element pinned to the centre of the viewport and the
 * camera looks THROUGH that point, so the camera's forward vector IS the
 * crosshair ray — there is nothing to unproject. Kept as a module scratch
 * because casting must not allocate any more than the rest of the frame does;
 * combat copies out of `direction` and retains nothing.
 */
const _aim = new THREE.Vector3();
/** Last cast's aim, for the automated tests. See __dbgMount. */
/**
 * Steer strength for a shot fired down the crosshair, as a fraction of the full
 * lock-on the auto-targeted cast uses. 0.35 closes a small aiming error over a
 * projectile's flight without ever dragging a shot onto something you did not
 * point at — turn it up and the crosshair stops being what decides the hit.
 */
const MOUNTED_HOMING = 0.35;
/**
 * Half-angle of the aim cone, as a cosine. 0.94 is ~20 degrees: wide enough
 * that a moving enemy under the reticle qualifies, narrow enough that one off
 * to the side never does.
 */
const AIM_CONE_COS = 0.94;

/** The enemy the crosshair is on, or null. Not the nearest — the one aimed at. */
function enemyInAim(from: THREE.Vector3, aim: THREE.Vector3, range: number): Damageable | null {
  let best: Damageable | null = null;
  let bestDot = AIM_CONE_COS;
  for (const e of combat.enemies) {
    if (e.isDead) continue;
    const dx = e.position.x - from.x;
    const dy = e.position.y + 0.55 - from.y;
    const dz = e.position.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range || d < 1e-3) continue;
    const dot = (dx * aim.x + dy * aim.y + dz * aim.z) / d;
    if (dot > bestDot) { bestDot = dot; best = e as unknown as Damageable; }
  }
  return best;
}

const lastCast = { skill: '', aimed: false, homing: false, x: 0, y: 0, z: 0 };

function castFromBeast(beast: BeastActor, skill: SkillDef): void {
  const cd = cooldowns.get(skill.id) ?? 0;
  if (cd > 0) return;

  // Riding it changes where its skills go: from the saddle you are the one
  // aiming, so the crosshair wins outright and the auto-target is not even
  // consulted. Nothing else about the cast changes — the beast still plays the
  // cast animation and the shot still leaves from its muzzle.
  const aimed = mount.isMounted && beast === mount.beast;
  let target: Damageable | null = null;
  if (aimed) {
    engine.camera.getWorldDirection(_aim);
    // Face the mount along the shot so the muzzle offset in beginCast points
    // the right way; the vertical component stays on the projectile only.
    if (Math.abs(_aim.x) + Math.abs(_aim.z) > 1e-4) {
      beast.forward.set(_aim.x, 0, _aim.z).normalize();
    }
    // A LITTLE homing from the saddle: the shot leaves down the crosshair and
    // then leans toward whatever the crosshair was actually on. The target is
    // picked from the aim CONE, never "nearest enemy" — an enemy off to the
    // side is not what you pointed at, and curving onto it would be the autoaim
    // this deliberately is not.
    target = enemyInAim(beast.position, _aim, Math.max(skill.range, 12));
  } else {
    target = combat.findNearestEnemy(beast.position, Math.max(skill.range, 12));
    if (target) {
      beast.forward.copy(target.position).sub(beast.position).setY(0).normalize();
    }
  }

  const { origin, direction } = beast.beginCast(skill);
  const dir = aimed
    ? _aim
    : target
      ? new THREE.Vector3().copy(target.position).sub(origin).normalize()
      : direction;
  combat.cast({
    skill,
    caster: beast as unknown as Damageable & { forward: THREE.Vector3 },
    origin,
    direction: dir,
    target,
    // Aimed shots steer at a fraction of full lock-on, so the crosshair stays
    // the thing that decides where a shot goes and the assist only closes the
    // last little error. Full strength would quietly undo the aim you took.
    homingScale: aimed ? MOUNTED_HOMING : 1,
    attackStat: beast.stats.attack,
  });
  lastCast.skill = skill.id;
  lastCast.aimed = aimed;
  lastCast.homing = !!target;
  lastCast.x = dir.x; lastCast.y = dir.y; lastCast.z = dir.z;
  cooldowns.set(skill.id, skill.cooldown);
}

function hotbarSkills(): SkillDef[] {
  return primary().knownSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillDef => !!s)
    .slice(0, 4);
}

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------
function buildOffers(): ShopOffer[] {
  const offers: ShopOffer[] = [];
  for (const beast of [primary(), support()]) {
    for (const id of beast.species.skills) {
      const def = getSkill(id);
      if (!def || def.storePrice === undefined) continue;
      offers.push({
        skill: def,
        price: def.storePrice,
        owned: beast.knownSkillIds.includes(id),
        beastId: beast.species.id,
        beastName: t(beast.species.nameKey),
        affordable: shards() >= def.storePrice,
      });
    }
  }
  return offers;
}

function tryOpenShop(): void {
  if (hud.isShopOpen()) return;
  document.exitPointerLock();
  hud.openShop(t('shop.skillDen.title'), buildOffers(), (i) => {
    const offer = buildOffers()[i];
    if (!offer || offer.owned || !offer.affordable) return;
    spent += offer.price;
    // By ID, not by name. This matched on the display name until the species
    // names moved into the string table, at which point a translated build would
    // have failed the lookup and charged for a skill nobody learned.
    const beast = [primary(), support()].find((p) => p.species.id === offer.beastId);
    beast?.learnSkill(offer.skill.id);
    hud.setShards(shards());
    bus.emit({
      type: 'toast',
      text: t('toast.learnedSkill', {
        beast: offer.beastName, skill: t(offer.skill.nameKey),
      }),
    });
    hud.openShop(t('shop.skillDen.title'), buildOffers(), () => {}, () => hud.closeShop());
  }, () => hud.closeShop());
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const beastHud = (p: BeastActor): BeastHudInfo => ({
  // Resolved here, not in the HUD: `BeastHudInfo` is a snapshot of what to DRAW.
  // `t(key)` with no vars hands back the table's own string, so this allocates
  // nothing even though it runs every frame.
  name: t(p.species.nameKey),
  element: p.species.element,
  level: p.level,
  xp: p.xp,
  xpToNext: p.xpToNext,
  hp: p.hp,
  maxHp: p.maxHp,
});

// ---------------------------------------------------------------------------
// Photo mode (for the visual critic pipeline):
//   ?photo=1&cam=x,y,z&look=x,y,z&beast=<speciesId>&anim=<action>
// cam/look are offsets relative to the spawn point.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
// Read from flags rather than from `params` here, because world/sway.ts needs
// the same answer to freeze its wind clock and two independent parses of the
// same URL is one too many.
const photoMode = flags.photo;
const parseVec = (s: string | null, fallback: THREE.Vector3): THREE.Vector3 => {
  if (!s) return fallback;
  const [x, y, z] = s.split(',').map(Number);
  return new THREE.Vector3(x, y, z);
};
if (photoMode) {
  if (params.get('hud') === '0') {
    const style = document.createElement('style');
    style.textContent = 'body > *:not(#app), #app > *:not(canvas) { display: none !important; }';
    document.head.appendChild(style);
  }
  const beastId = params.get('beast');
  if (beastId || params.get('poff')) {
    // Portraits happen on open, FLAT ground so the camera never ends up buried
    // in a hillside. Each species starts from its own bearing on a ring (so ten
    // portraits aren't ten copies of the same postcard) then walks outward
    // until it finds a level, dry patch.
    const idx = Math.max(0, roster.findIndex((p) => p.species.id === beastId));
    const ring = (idx / roster.length) * Math.PI * 2;
    const base = world.spawnPoint;

    /** Max height deviation within ~3 units — low means level ground. */
    const flatness = (x: number, z: number): number => {
      const h = world.getHeight(x, z);
      let worst = 0;
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]]) {
        worst = Math.max(worst, Math.abs(world.getHeight(x + dx, z + dz) - h));
      }
      return worst;
    };

    /**
     * Penalty for standing near a shop: buildings became the backdrop of three
     * portraits, putting the subject in hard building shadow against a black
     * wall. Anything within 14 units is heavily penalised.
     */
    const backdropPenalty = (x: number, z: number): number => {
      let worst = 0;
      for (const s of world.shopPositions) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 14) worst = Math.max(worst, (14 - d) * 0.5);
      }
      return worst;
    };

    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const radius of [16, 21, 26, 31, 12]) {
      for (let k = -4; k <= 4; k++) {
        const a = ring + k * 0.26;
        const x = base.x + Math.cos(a) * radius;
        const z = base.z + Math.sin(a) * radius;
        if (world.getHeight(x, z) < world.waterLevel + 0.6) continue; // not in the shallows
        // Score on level ground AND a clean backdrop, not flatness alone.
        const score = flatness(x, z) + backdropPenalty(x, z);
        if (score < bestScore) { bestScore = score; best = new THREE.Vector3(x, 0, z); }
        if (score < 0.7) break; // good enough, take it
      }
      if (bestScore < 0.7) break;
    }

    const spot = params.get('poff')
      ? parseVec(params.get('poff'), base).add(base)
      : (best ?? base);
    player.position.x = spot.x;
    player.position.z = spot.z;
    player.position.y = Math.max(world.getHeight(spot.x, spot.z) + 0.1, world.waterLevel + 0.2);
  }
  if (beastId) {
    const idx = roster.findIndex((p) => p.species.id === beastId);
    if (idx >= 0) primaryIdx = idx;
    // Staged portraits show ONE subject: hide the hero and every other beast so
    // the party stops intruding into the corner of every frame.
    roster.forEach((p, i) => p.setVisible(i === primaryIdx));
    player.root.visible = false;
  }
}
const photoCam = parseVec(params.get('cam'), new THREE.Vector3(6, 4, 8)).add(world.spawnPoint);
const photoLook = parseVec(params.get('look'), new THREE.Vector3(0, 1, 0)).add(world.spawnPoint);
const photoAnim = params.get('anim');
let photoAnimTimer = 0;

// Touch overlay: only exists on devices with a touch screen (null otherwise,
// so nothing is added to the DOM and there is no per-frame cost).
const touch = photoMode ? null : TouchControls.attach(input);

// ---------------------------------------------------------------------------
// The display language can change while the game is running — the start menu's
// Settings picker calls `setLanguage`. Almost nothing needs to hear about it,
// because almost every string in this file is looked up on its way to the HUD
// each slice and arrives translated on its own. What is listed here is the
// exhaustive set of places that CAPTURED a string earlier and would otherwise
// hold yesterday's language:
//
//   - the two composed hint pills and the dialogue footer above, which are
//     hoisted out of the frame loop precisely because they allocate;
//   - the per-NPC prompt cache, which is keyed by person, not by language;
//   - the HUD's and the touch overlay's own baked-in captions, each of which
//     knows its own list (see `relabel` in both).
//
// The zone names are absent on purpose: they are getters now, so they cannot go
// stale. Nothing here runs per frame; this fires when a player picks a language.
// ---------------------------------------------------------------------------
onLanguageChange(() => {
  composeKeyHints();
  hud.relabel();
  touch?.relabel();
});

// Gamepad: non-null wherever the API exists, whether or not anything is plugged
// in yet — a pad can arrive mid-session and the connect listener has to be live
// to catch it. It stays free until one does; see core/gamepad.ts.
// Stored player choices, read once. URL beats preference and never writes back
// — see core/flags.ts.
//
// Both this and the feedback mixer below are ASSIGNMENTS, not declarations —
// they are declared at the top of the file, above the title screen, because the
// menu's Settings panel can throw either of their switches before this line has
// run. See the boot-order note there. `loadPrefs()` is read HERE rather than at
// the top for the same reason: a switch thrown while the world was being built
// has already been persisted, and reading late is what picks it up.
const prefs = loadPrefs();
pad = photoMode ? null : GamepadControls.attach(input, {
  look: {
    invertX: flags.invertLookX ?? prefs.invertLookX,
    invertY: flags.invertLookY ?? prefs.invertLookY,
  },
});

// Rumble and camera shake, driven off the bus. Null in photo mode for the same
// reason the touch overlay is: a staged capture must not have the camera kicked
// out from under it by whatever happened to be hitting the hero.
//
feedback = photoMode ? null : new FeedbackSystem({
  bus,
  camera: player.cam,
  pad: () => pad?.current ?? null,
  // Live, per frame: rumble belongs to the device in the player's hands, so a
  // controller left plugged in beside the keyboard stops buzzing the moment the
  // keyboard is touched, and starts again the moment the pad is. See
  // `FeedbackDeps.tactileInput` and `Input.tactile`.
  tactileInput: () => input.tactile,
  hapticFeedback: prefs.hapticFeedback,
  hapticIntensity: flags.haptics ?? prefs.hapticIntensity,
  shakeIntensity: flags.shake ?? prefs.shakeIntensity,
});

// The title screen itself is built at the TOP of this file, before a single
// chunk exists — see the boot-order note there. It is the first thing on screen
// and the game does not begin until it says so, and it is now a gate in the
// strongest sense available: `frame()` is not running behind it at all.

// Probes for the automated input tests (tools/test-touch.mjs). Read-only.
interface DebugProbes {
  __dbgPlayerPos: () => { x: number; y: number; z: number };
  __dbgCam: () => {
    x: number; y: number; z: number; pitch: number;
    dir: { x: number; y: number; z: number };
  };
  __dbgCamYaw: () => number;
}
(window as unknown as DebugProbes).__dbgPlayerPos = () => ({
  x: player.position.x, y: player.position.y, z: player.position.z,
});
// Camera position AND view pitch, for measuring follow behaviour over terraced
// ground. Pitch is the one that matters: the terrain steps a whole unit at a
// time, and an unsmoothed look target turns that into a several-degree snap of
// the whole frame in a single frame (see ThirdPersonCamera's step smoothing).
const _dbgDir = new THREE.Vector3();
/** Scratch for the compass's per-frame camera forward. Never allocate in frame(). */
const _compassFwd = new THREE.Vector3();
/** Scratch for `__dbgHurt`'s source position. */
const _hurtFrom = new THREE.Vector3();
(window as unknown as DebugProbes).__dbgCam = () => {
  engine.camera.getWorldDirection(_dbgDir);
  return {
    x: engine.camera.position.x, y: engine.camera.position.y, z: engine.camera.position.z,
    pitch: (Math.asin(Math.max(-1, Math.min(1, _dbgDir.y))) * 180) / Math.PI,
    // The camera looks THROUGH the centre of the viewport, and the crosshair is
    // pinned there (proved pixel-wise by tools/test-crosshair.mjs), so this
    // vector IS the crosshair ray. It is what a mounted cast aims along.
    dir: { x: _dbgDir.x, y: _dbgDir.y, z: _dbgDir.z },
  };
};
// Compass state: the heading under the pointer and where every marker landed
// on the strip. `rel` is the signed shortest-arc bearing to the marker in
// degrees, `clamped` says it fell off the end of the strip and is parked at the
// edge. Read-only.
(window as unknown as { __dbgCompass: () => unknown }).__dbgCompass = () => hud.compassDebug();
(window as unknown as DebugProbes).__dbgCamYaw = () => Math.atan2(
  engine.camera.position.x - player.position.x,
  engine.camera.position.z - player.position.z,
);
(window as unknown as { __dbgInput: () => unknown }).__dbgInput = () => ({
  axisFwd: input.axisFwd,
  axisSide: input.axisSide,
  lookActive: input.lookActive,
  touchActive: input.touchActive,
  touchOverlay: !!document.querySelector('.bs-touch'),
  // Buttons, edges and per-source sticks. ADDITIVE — tools/test-touch.mjs dumps
  // this object wholesale, so keys may be added here but never renamed.
  ...(input.debugState() as object),
  vel: { x: +player.velocity.x.toFixed(2), y: +player.velocity.y.toFixed(2), z: +player.velocity.z.toFixed(2) },
  onGround: player.onGround,
  // Which SURFACE is holding him up: false is the terrain, true is a tree crown
  // (the one-way platform — see World.climbTopAt). The pair is what tells a
  // treetop apart from a hilltop in a trace.
  onCanopy: player.onCanopy,
  isClimbing: player.isClimbing,
  attacking: player.isAttacking,
  isSwimming: player.isSwimming,
  isMounted: player.isMounted,
  isDead: player.isDead,
  // The keys the game swallows before the browser can act on them. Reported so
  // tools/test-keybinds.mjs can cross-check it against the bindings table
  // rather than trusting that whoever added a key remembered — see the note on
  // Input.CAPTURED, which has now been forgotten once per function key.
  captured: Input.capturedCodes(),
});

// Controller state: what is plugged in, which faces the HUD is printing, and the
// raw axes/pressed set. Read-only. `connected` stays false until the pad's first
// button press on Chrome, which is the browser's rule, not ours.
(window as unknown as { __dbgPad: () => unknown }).__dbgPad = () => pad?.debugState() ?? null;

// The feedback layer: how many cues drained, the rumble mixer's mode and level,
// and the silent audio channel's call count. Read-only. `haptics.issues` is the
// number of actual playEffect calls, which is what proves the 12 Hz cadence is
// doing its job rather than the mixer re-issuing every frame.
(window as unknown as { __dbgFeedback: () => unknown }).__dbgFeedback =
  () => feedback?.debugState() ?? null;

// TEST HOOK, like `__dbgTp`: hurt the hero for a fixed amount from a fixed
// direction. Waiting for a real enemy to connect is not deterministic enough to
// assert feedback timing — or the invulnerability window — against.
(window as unknown as { __dbgHurt: (n: number) => void }).__dbgHurt = (n: number) => {
  _hurtFrom.set(player.position.x, player.position.y, player.position.z - 1);
  player.takeDamage(n, _hurtFrom);
};

// Submerged-camera state. Read-only, and the only way to assert on an effect
// that is otherwise a screen-space colour: `amount` is the smoothed 0..1 ramp
// the tint, the murk and the bubbles all key off, `depth` is how far the LENS is
// under the surface (which is not how deep the hero is — see world/underwater.ts)
// and `fogNear` shows the murk actually reached the scene.
(window as unknown as { __dbgUnder: () => unknown }).__dbgUnder = () => ({
  amount: +underwater.amount.toFixed(3),
  depth: +underwater.depth.toFixed(2),
  camY: +engine.camera.position.y.toFixed(2),
  overWater: world.isWater(engine.camera.position.x, engine.camera.position.z),
  fogNear: +((engine.scene.fog as THREE.Fog | null)?.near ?? -1).toFixed(1),
  fogFar: +((engine.scene.fog as THREE.Fog | null)?.far ?? -1).toFixed(1),
  // The per-channel absorption the distance is filtered by — 1,1,1 above water.
  // See installAerialPerspective in core/engine.ts and WATER_ABSORB in
  // world/underwater.ts; this is the number that says whether the murk is
  // fading toward daylight or toward water.
  fogAbsorb: ((): number[] => {
    const f = engine.scene.fog as THREE.Fog | null;
    return f ? [+f.color.r.toFixed(3), +f.color.g.toFixed(3), +f.color.b.toFixed(3)] : [];
  })(),
});

// Mount state. Read-only, and the one probe the mount tests need: the hold
// fill, which beast is under you and what it is, the rider's height and speed,
// and the direction the last cast actually left in — `aimed` says whether that
// direction came from the crosshair or from the auto-target.
(window as unknown as { __dbgMount: () => unknown }).__dbgMount = () => ({
  mounted: mount.isMounted,
  beast: mount.beast?.species.id ?? null,
  locomotion: mount.beast?.species.locomotion ?? null,
  beastSpeed: mount.beast ? +mount.beast.stats.speed.toFixed(2) : null,
  hold: +mount.progress.toFixed(3),
  speed: +mount.speed.toFixed(2),
  /** Which way the mount itself is pointing — NOT where a mounted cast goes. */
  yaw: mount.beast ? +Math.atan2(mount.beast.forward.x, mount.beast.forward.z).toFixed(3) : null,
  forward: mount.beast
    ? { x: +mount.beast.forward.x.toFixed(3), z: +mount.beast.forward.z.toFixed(3) }
    : null,
  y: +player.position.y.toFixed(2),
  ground: +world.getHeight(player.position.x, player.position.z).toFixed(2),
  lastCast: { ...lastCast },
});

// Fetch-errand probes. `__dbgFetch` is read-only, the same contract as the
// probes above; `__dbgDrop` is a TEST HOOK — the only way to stage a specific
// item on the ground without farming enemies until the loot table obliges, and
// what tools use to prove the fetch rule (currency always, stackables only when
// already held) case by case.
(window as unknown as { __dbgFetch: () => unknown }).__dbgFetch = () => ({
  shards: shards(),
  bag: bag.entries().map((e) => ({ id: e.def.id, count: e.count })),
  drops: combat.dropSnapshot(),
  support: {
    // Probes report the IDENTIFIER, not the display name: a tool asserting on
    // `__dbgFetch().support.id` must not start failing under `?lang=sv`.
    id: support().species.id,
    fetching: support().isFetching,
    carrying: support().isCarrying,
    item: support().fetchItemId,
    pos: { x: +support().position.x.toFixed(2), z: +support().position.z.toFixed(2) },
  },
  primary: { id: primary().species.id, fetching: primary().isFetching },
});
// TEST HOOK, like __dbgDrop below: put the hero at an absolute column in the
// ACTIVE zone. The zone tools need to place him at an exact distance from a
// gateway and hold him there — "walk for 1.4 s and hope" cannot demonstrate
// that a 3.0-unit enter radius and a 5.0-unit exit radius behave differently,
// and the oscillation test needs to cross a boundary at a known rate.
(window as unknown as { __dbgTp: (x: number, z: number) => void }).__dbgTp = (x, z) => {
  player.position.x = x;
  player.position.z = z;
  player.position.y = Math.max(world.getHeight(x, z), world.waterLevel);
  player.velocity.set(0, 0, 0);
};
// The steering half of the same hook: swing the camera so that a held W means
// "walk along THAT bearing". Movement is camera-relative, so a collision test
// that cannot turn the camera can only ever drive the hero in one direction.
// Takes a walk bearing, NOT the camera's own yaw — see Player.aimCamera — and
// the swing arrives over a few hundred ms, so wait for __dbgCamYaw to agree.
(window as unknown as { __dbgAim: (bearing: number) => void }).__dbgAim = (bearing) => {
  player.aimCamera(bearing);
};
// Melee aim assist, as the game would answer it RIGHT NOW: who the next swing
// would be steered onto, how far off the crosshair they are, and how far the
// swing would have to turn to reach them. Read-only, and it runs the shipped
// query rather than a copy of it, so a change to the rule shows up here.
//
// `angleFromCrosshair` is the SELECTION criterion — the enemy's bearing from the
// hero against the bearing the camera is pointing — and `turn` is what the swing
// actually does, from the hero's current facing. They differ by however far his
// heading is lagging the camera, which is the one thing that lets a turn come
// out wider than the cone. See CombatSystem.bestMeleeTarget.
// `inReach` beside it is what makes a REFUSAL checkable. It is the same shipped
// query with the cone opened to 180 degrees — one argument apart, not a second
// copy of the rule — so it answers "who was standing close enough to be steered
// at, whatever the crosshair was doing". A null `target` next to a non-null
// `inReach` is the cone doing its job; both null is nobody in range. Without the
// pair, a tool can only ever prove the assist FIRED, never that it correctly
// declined, and "declined" is half of what the issue asked for.
(window as unknown as { __dbgAimAssist: () => unknown }).__dbgAimAssist = () => {
  engine.camera.getWorldDirection(_aimDir);
  _dbgStrike.copy(player.position);
  _dbgStrike.y += 1.25;
  const target = combat.bestMeleeTarget(_dbgStrike, _aimDir, SWORD_REACH, AIM_ASSIST_CONE_COS);
  const inReach = combat.bestMeleeTarget(_dbgStrike, _aimDir, SWORD_REACH, -1);
  const deg = (r: number): number => +((r * 180) / Math.PI).toFixed(2);
  const bearing = (dx: number, dz: number): number => Math.atan2(dx, dz);
  const aim = bearing(_aimDir.x, _aimDir.z);
  const shortest = (a: number): number => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const describe = (e: Damageable | null): unknown => {
    if (!e) return null;
    const dx = e.position.x - _dbgStrike.x;
    const dz = e.position.z - _dbgStrike.z;
    return {
      x: +e.position.x.toFixed(2), z: +e.position.z.toFixed(2),
      distance: +Math.hypot(dx, dz).toFixed(2),
      angleFromCrosshair: deg(Math.abs(shortest(bearing(dx, dz) - aim))),
      turn: deg(Math.abs(shortest(
        bearing(dx, dz) - bearing(player.forward.x, player.forward.z),
      ))),
    };
  };
  return {
    enabled: flags.aimAssist,
    coneDeg: deg(Math.acos(AIM_ASSIST_CONE_COS)),
    reach: SWORD_REACH,
    target: describe(target),
    inReach: describe(inReach),
  };
};
/** Scratch for `__dbgAimAssist`'s strike point. */
const _dbgStrike = new THREE.Vector3();
/** Scratch for the crown probe below; the query never allocates. */
const _dbgCrown: CrownContact = { treeX: 0, treeZ: 0, crownR: 0, crownCy: 0, crownRy: 0 };
// Contact-particle pool. Read-only, and the only way to state the recycling
// rule as a number rather than as a claim: `recycledAirborne` must be 0 for the
// life of the process, `retired` counts settled particles shrunk out early to
// make room, and `dropped` counts bursts refused because everything was in the
// air. `ms` is the pool's own update cost (populated under ?perf=1 only).
(window as unknown as { __dbgTouchFx: () => unknown }).__dbgTouchFx = () => ({
  ...touchFx.stats(),
  crown: world.crownContactAt(
    player.position.x, player.position.y + 1, player.position.z, 0.65, _dbgCrown,
  ) ? { ..._dbgCrown } : null,
});
// TEST HOOK, like __dbgDrop. Force a burst without finding a tree first, which
// is the only practical way to drive the pool to exhaustion on demand and show
// what the policy does there. Returns how many of `n` were actually placed.
(window as unknown as { __dbgTouchBurst: (n: number) => number }).__dbgTouchBurst =
  (n) => touchFx.forceBurst(player, n);
(window as unknown as { __dbgDrop: (id: string, dx: number, dz: number) => void })
  .__dbgDrop = (id, dx, dz) => {
    const x = player.position.x + dx, z = player.position.z + dz;
    combat.spawnDrop(id, x, world.getHeight(x, z) + 0.5, z);
  };

let started = false;
// The welcome toast lives in `beginPlay()` at the top of this file — it is the
// first thing the player is told, and it has to be said when they are looking
// at the game rather than at a poster or a loading bar. Photo mode and `menu=0`
// never fire it, and neither wants a toast in shot.

/**
 * Frame-rate cap, in fps. `?fps=<n>` overrides it and `?fps=0` removes it.
 *
 * 120 BY DEFAULT, where this used to be uncapped. A browser already pins
 * requestAnimationFrame to the display, so "uncapped" never meant unbounded —
 * it meant "however fast this particular monitor happens to be", which on a
 * 165 Hz panel is 165 frames of a scene whose cost is 4.97 ms of MAIN THREAD
 * each. Measured there, walking: 80.5% of a core spent on frames, and `render`
 * — draw submission, 549 calls and 3.1M triangles — is 67% of every one of
 * them. The frame count is the only term in that product the game controls.
 *
 * 120 rather than 60 because this is an action game and the difference between
 * 60 and 120 is something a player feels on a high-refresh panel, where the
 * difference between 120 and 165 is not. On a 60 Hz display the cap never
 * binds and nothing changes at all.
 *
 * It is a DEADLINE, not a sleep, and `Engine.beginFrame` explains why: rAF only
 * offers times on the refresh grid, so an interval-based cap always undershoots
 * (a 30 fps cap measured 26.7). Skipped frames roll their elapsed time into the
 * next one, so the simulation is unaffected — see `Engine.tick`.
 */
const DEFAULT_FPS_CAP = 120;
const fpsCap = Number(params.get('fps') ?? DEFAULT_FPS_CAP);
engine.setFpsCap(fpsCap);
const debug = new DebugOverlay(engine.renderer, fpsCap);
if (params.get('debug') === '1') debug.toggle();

/**
 * The F3 panel's model, and the ten functions that make its switches real.
 *
 * COMPOSITION-ROOT POLICY, which is why the sinks live here and not in gfx.ts:
 * that file knows "bloom is a boolean that defaults on"; this one is the only
 * place that knows what a bloom pass, a chunk mesh and a frame cap are. Same
 * shape as `FeedbackDeps` above.
 *
 * The world layers go through `world`, which is a `let` that the zone manager
 * rebinds on a switch — so this reads it at call time rather than capturing it,
 * and `gfx.applyAll()` runs again after a switch (see `bindZone`) because the
 * new zone's meshes are new objects that never saw the setting.
 */
const gfx = new Gfx({
  grass: (on) => world.setLayerVisible('grass', on),
  props: (on) => world.setLayerVisible('props', on),
  water: (on) => world.setLayerVisible('water', on),
  clouds: (on) => world.setLayerVisible('clouds', on),
  shadows: (on) => engine.setShadowsEnabled(on),
  ao: (on) => engine.setPassEnabled('ao', on),
  bloom: (on) => engine.setPassEnabled('bloom', on),
  aa: (on) => engine.setPassEnabled('aa', on),
  // `?fps=` beats the stored preference for this load and never writes it back,
  // the same resolution the look-axis and shake overrides use — a measurement
  // run can pin a value and cannot corrupt one.
  fpsCap: (n) => {
    const v = params.get('fps') !== null ? fpsCap : n;
    engine.setFpsCap(v);
    debug.setFpsCap(v);
  },
});
const perfPanel = new PerfPanel(gfx);

/**
 * The custom cursor, and the one question the world has to answer for it.
 *
 * `at()` is called only while the pointer is free and only for points over the
 * canvas, so it runs on mouse movement in a menu-ish mode rather than per frame
 * — which is what makes a screen-space scan of every enemy affordable. It is a
 * PROJECTION, not a raycast: projecting a few dozen positions into screen space
 * costs a matrix multiply each, where a raycast against the streamed world would
 * walk hundreds of chunk meshes for an answer no more true. Nearest wins, so a
 * hostile standing in front of a friendly reads as the hostile.
 */
const cursors = new Cursors();
const _curProj = new THREE.Vector3();
/** Second scratch, so the NPC scan never clones. See the loop below. */
const _curNpc = new THREE.Vector3();
const cursorDirector = new CursorDirector(cursors, {
  at: (px, py) => {
    const rect = engine.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    /** Screen distance in px, or Infinity when the point is behind the lens. */
    const screenGap = (p: THREE.Vector3, lift: number): number => {
      _curProj.set(p.x, p.y + lift, p.z).project(engine.camera);
      if (_curProj.z > 1) return Infinity;
      const sx = rect.left + (_curProj.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-_curProj.y * 0.5 + 0.5) * rect.height;
      return Math.hypot(sx - px, sy - py);
    };
    // Generous, because these are small figures at gameplay distance and a
    // pixel-exact hit test on a 2-metre creature 40 units away is unusable.
    const REACH = 46;
    // An OBJECT rather than two locals, and not for tidiness: TypeScript's
    // control-flow analysis does not follow assignments made inside a closure,
    // so a `let best = null` written only by `offer` narrows to `never` by the
    // return and the property read fails to compile. A property on an object is
    // not narrowed that way.
    const best = { gap: Infinity, state: null as CursorState | null };
    const offer = (gap: number, state: CursorState): void => {
      if (gap < REACH && gap < best.gap) { best.gap = gap; best.state = state; }
    };
    for (const e of combat.enemies) {
      if (e.hp > 0) offer(screenGap(e.position, 0.9), 'attack-target');
    }
    // `_curNpc` rather than a clone per NPC: this runs on every mouse move, and
    // the no-per-frame-allocation rule covers anything on a movement path.
    for (const n of world.npcs?.all ?? []) {
      _curNpc.set(n.x, n.y, n.z);
      offer(screenGap(_curNpc, 1.2), 'inspect');
    }
    // A skill den is a building you can walk into and read — the same
    // "there is more to see here" the magnifier means.
    for (const s of world.shopPositions) offer(screenGap(s, 1.5), 'inspect');
    return best.state;
  },
});
void cursors.load();

/**
 * ALT FREES THE POINTER, and it is a TOGGLE rather than a hold.
 *
 * The obvious build is "cursor while Alt is down", and it is wrong twice over.
 * A player using the F3 panel flips several rows in a row, so a hold turns
 * every click into a two-handed operation; and Alt+click is claimed by the
 * window manager on most Linux desktops (it drags windows) and by parts of
 * Windows, so the clicks would land somewhere else entirely. Pressed, released,
 * then click normally — nothing is holding Alt when the button goes down.
 *
 * It is NOT a modal: the hero keeps taking input, exactly as he does with the
 * F3 panel open, because the point of both is to change something while the
 * world carries on doing real work. What is lost is mouse LOOK, which is the
 * pointer lock, which is the thing being traded away on purpose.
 */
let cursorFree = false;
function setCursorFree(on: boolean): void {
  cursorFree = on;
  cursorDirector.setEnabled(on);
  if (on) input.releaseLock();
  else if (!isTouchPrimary()) input.requestLock();
}
// A click anywhere reaches the panel first; it returns false unless the click
// landed on one of its rows, so the world still gets every other click.
window.addEventListener('mousedown', (e) => {
  if (perfPanel.handleClick(e.target, e)) { e.preventDefault(); e.stopPropagation(); }
}, true);
// A drag owns the cursor until it ends — the pointer leaves the handle within a
// few pixels, and without this the picture would snap back mid-resize. The
// panel does not know what a CursorState is; it says "dragging" and this
// decides which one, which keeps ui/cursor.ts out of ui/perf-panel.ts.
perfPanel.onDragCursor = (state, dragging) => {
  if (!dragging) { cursorDirector.lock(null); return; }
  cursorDirector.lock((state as CursorState | null)
    ?? (cursors.debug().state ?? 'move'));
};

// There USED to be a `MENU_FPS = 20` cap here, and the history is worth keeping
// because it is what the current arrangement replaced.
//
// The game's loop ran behind the poster. Uncapped it drew at the display's
// refresh rate — 165 fps on the machine this was measured on — and every one of
// those frames was a full pass of the world plus GTAO, bloom and SMAA behind an
// opaque picture. Measured over a 6 s window at 1920x1080: 96.9% of the main
// thread with the menu up, of which 93.4% was the game; capped to 20 it was 27%.
//
// The cap was a good answer to the wrong question. What was wanted was for the
// world to keep STREAMING behind the poster, and rendering it was only ever the
// means: the streamer's budget is spent per rendered frame. The boot sequence
// now drains that queue itself, on purpose and to completion, and then stops —
// so there is no loop left to cap, an idle title screen costs the poster's CSS
// and nothing else, and `beginPlay()` hands the renderer straight to the rate
// this load actually asked for. See the boot-order note at the top of the file.

// PINNED rather than just enabled: the F2 overlay also turns sampling on while
// it is open (see DebugOverlay.toggle), and closing it must not silence a run
// the harness in tools/ asked for.
if (params.get('perf') === '1') perf.pin();
let lastPrograms = 0;

// ---------------------------------------------------------------------------
// Developer console (§) and its commands. The console owns no game knowledge —
// commands are registered here, where the systems they poke actually live, and
// /help builds its listing from the registry so a new command lists itself.
// ---------------------------------------------------------------------------
const devConsole = photoMode ? null : new DevConsole();
const colliderView = new ColliderView(engine.scene, world);
bound.push(colliderView);
// `colliders=1` starts them visible, which is how a staged capture can show the
// cage against the mesh — photo mode has no console to type into.
if (params.get('colliders') === '1') colliderView.setVisible(true);
devConsole?.register({
  name: 'show-colliders',
  args: '[on|off]',
  help: 'Toggle collision volumes: green = solid (tree discs + structure boxes), blue = climbable.',
  run: (args) => {
    const on = args[0] === 'on' ? true : args[0] === 'off' ? false : !colliderView.isVisible;
    colliderView.setVisible(on);
    return on
      ? `colliders ON — ${colliderView.count} drawn, ${colliderView.boxCount} settlement `
        + `boxes and ${colliderView.ridgeCount} roof arches (green solid, blue climb)`
      : 'colliders OFF';
  },
});
devConsole?.register({
  name: 'gfx',
  args: '[<setting> [on|off|<n>]]',
  help: 'Read or set the F3 performance toggles. No arguments lists them.',
  run: (args) => {
    const [id, raw] = args;
    // No argument: the whole table, which is also what makes the command
    // discoverable — the ids are the same strings the panel and __dbgGfx use.
    if (!id) {
      const snap = gfx.snapshot();
      return GFX_OPTIONS.map((o) => `${o.id.padEnd(9)} ${String(snap[o.id])}`).join('\n')
        + '\n(F3 opens the panel)';
    }
    const opt = GFX_OPTIONS.find((o) => o.id === id);
    if (!opt) return `no such setting "${id}" — ${GFX_OPTIONS.map((o) => o.id).join(', ')}`;
    if (raw === undefined) return `${opt.id} ${String(gfx.get(opt.id))}`;
    // `on`/`off` for the switches and a bare number for the choice rows; the
    // registry validates and answers with what it actually stored, so a value
    // outside the list reports the default rather than silently doing nothing.
    const value = opt.choices ? Number(raw) : raw !== 'off' && raw !== 'false' && raw !== '0';
    const now = gfx.set(opt.id, value);
    perfPanel.refresh();
    return `${opt.id} ${String(now)}`;
  },
});
devConsole?.register({
  name: 'mount',
  args: '[off|<speciesId>]',
  help: 'Ride the primary beast without the 2s hold; /mount off dismounts.',
  run: (args) => {
    const arg = args[0];
    // The console is a DEVELOPER surface: it stays in English and it answers in
    // SPECIES IDS, which is also what its own argument takes. A localised name
    // here would mean `/mount` printing something you cannot type back at it.
    if (arg === 'off') {
      if (!mount.isMounted) return 'not mounted';
      const id = mount.beast!.species.id;
      mount.dismount();
      return `dismounted ${id}`;
    }
    if (mount.isMounted) return `already riding ${mount.beast!.species.id} — /mount off first`;
    if (arg) {
      const idx = roster.findIndex((p) => p.species.id === arg);
      if (idx < 0) return `no such beast "${arg}" — ${roster.map((p) => p.species.id).join(', ')}`;
      if (idx === supportIdx) supportIdx = primaryIdx;
      primaryIdx = idx;
      refreshVisibility();
    }
    const why = mount.refusal(primary());
    if (why !== 'none') return `cannot mount: ${why}`;
    mount.mount(primary());
    return `riding ${primary().species.id} (${primary().species.locomotion})`;
  },
});
/**
 * Read or write one feedback preference, honouring the URL override.
 *
 * A pinned flag is reported and NOT written through: a measurement run may
 * shadow what the player chose for the length of that load, and must not
 * quietly become what they chose.
 */
function setFeedbackPref(
  key: 'hapticIntensity' | 'shakeIntensity', raw: string | undefined, pinned: number | null,
): string {
  if (raw === undefined) {
    const at = pinned ?? loadPrefs()[key];
    return `${key} = ${at}${pinned !== null ? ' (pinned by URL)' : ''}`;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) return 'usage: 0..1';
  savePrefs({ [key]: v });
  if (pinned !== null) return `saved ${key} = ${v}, but this load is pinned to ${pinned}`;
  feedback?.setOptions({ [key === 'hapticIntensity' ? 'hapticIntensity' : 'shakeIntensity']: v });
  return `${key} = ${v}`;
}

// Feedback tuning. The title screen's Settings panel is the PLAYER's surface
// now, and it deliberately shows switches rather than dials — on/off is a
// choice, 0.62 rumble is a tuning session. These commands are the dial half,
// for that session and for a bug report, and they write the same keys the panel
// does (core/prefs.ts) so the two never disagree. `?haptics=` / `?shake=` pin a
// value for one load without writing anything.
devConsole?.register({
  name: 'haptics',
  args: '[<0..1>]',
  help: 'Show or set controller rumble strength. Persists.',
  run: (args) => setFeedbackPref('hapticIntensity', args[0], flags.haptics),
});
devConsole?.register({
  name: 'vibration',
  args: '[0|1]',
  help: 'Show or set the controller-vibration switch. Persists. On by default.',
  run: (args) => {
    if (args[0] === undefined) return `hapticFeedback = ${loadPrefs().hapticFeedback}`;
    if (args[0] !== '0' && args[0] !== '1') return 'usage: 0 or 1';
    const on = args[0] === '1';
    savePrefs({ hapticFeedback: on });
    // Live, like the menu's row: turning it off silences whatever is ringing.
    feedback?.setOptions({ hapticFeedback: on });
    return `hapticFeedback = ${on}`;
  },
});
devConsole?.register({
  name: 'shake',
  args: '[<0..1>]',
  help: 'Show or set camera-shake strength. Persists.',
  run: (args) => setFeedbackPref('shakeIntensity', args[0], flags.shake),
});
devConsole?.register({
  name: 'invertlook',
  args: '<x|y> [0|1]',
  help: 'Show or set controller look inversion. Persists. Y is on by default.',
  run: (args) => {
    const axis = (args[0] ?? '').toLowerCase();
    if (axis !== 'x' && axis !== 'y') return 'usage: /invertlook <x|y> [0|1]';
    const key = axis === 'x' ? 'invertLookX' : 'invertLookY';
    const pinned = axis === 'x' ? flags.invertLookX : flags.invertLookY;
    if (args[1] === undefined) {
      const at = pinned ?? loadPrefs()[key];
      return `${key} = ${at}${pinned !== null ? ' (pinned by URL)' : ''}`;
    }
    if (args[1] !== '0' && args[1] !== '1') return 'usage: 0 or 1';
    const on = args[1] === '1';
    savePrefs({ [key]: on });
    if (pinned !== null) return `saved ${key} = ${on}, but this load is pinned to ${pinned}`;
    // Applied live rather than at the next load: this is the one setting whose
    // effect you can only judge with the stick in your hand.
    pad?.setLookAxes(axis === 'x' ? { invertX: on } : { invertY: on });
    return `${key} = ${on}`;
  },
});
devConsole?.register({
  name: 'zone',
  args: '[<id>]',
  help: 'Show the active zone, or switch to one now (skips the gateway dwell).',
  run: (args) => {
    if (!args[0]) {
      return `${zones.id} (${zones.name}) — ${zones.world.chunksLoaded} chunks, `
        + `${zones.transitions} transition(s). Zones: ${zones.zoneIds.join(', ')}`;
    }
    // A forced switch builds and warms the destination synchronously, which is
    // one long frame. That is the frame the preload band exists to avoid, and
    // seeing the difference is half of what this command is for.
    return zones.switchTo(args[0]);
  },
});
devConsole?.register({
  name: 'tp',
  args: '<dx> <dz>',
  help: 'Move the hero by an offset, for reaching something to inspect.',
  run: (args) => {
    const dx = Number(args[0]);
    const dz = Number(args[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return 'usage: /tp <dx> <dz>';
    player.position.x += dx;
    player.position.z += dz;
    player.position.y = Math.max(
      world.getHeight(player.position.x, player.position.z),
      world.waterLevel,
    );
    return `moved to ${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)}`;
  },
});

// ---------------------------------------------------------------------------
// Fixed-timestep simulation, decoupled from the render cadence.
//
// The world advances in SIM_DT slices regardless of how often we draw, and the
// leftover time is carried to the next frame. Two things this buys:
//
//   - The simulation no longer changes shape with the display. On a 144 Hz panel
//     it used to run 144 tiny steps a second, on a slow frame one 50 ms step
//     (that being the clamp in Engine.tick, which is itself a symptom of a
//     variable-dt sim), and steering, damping and gravity all behaved slightly
//     differently in each case.
//   - After a long stall the backlog is replayed in bounded steps instead of
//     arriving as one enormous dt, so nothing tunnels through the ground.
//
// MAX_STEPS bounds the catch-up. Without it, a frame that takes longer than the
// steps it queues makes the next frame queue even more — the classic spiral
// where a hitch becomes a hang. When the cap is hit the backlog is DROPPED, not
// carried: the world loses that time, which is the correct trade (a stalled
// tab should not fast-forward when it returns).
//
// What this does NOT do is fix a hitch: measured, the freezes in this game are
// first-use shader compilation in the GPU process, and JavaScript has one thread
// for simulation and drawing either way. Decoupling makes the sim behave the
// same on every machine; it cannot make a blocked GPU return sooner.
//
// `simhz=<n>` overrides the rate for experiments.
const SIM_HZ = Math.max(20, Number(params.get('simhz') ?? 60));
const SIM_DT = 1 / SIM_HZ;
const MAX_STEPS = 4;
let simAccumulator = 0;

/**
 * One simulation slice. Called with a fixed dt, possibly several times per
 * rendered frame, possibly none.
 *
 * `first` is true only on the slice that owns this frame's input edges.
 * input.pressed() stays true for the whole frame, so a discrete action read on
 * every slice would fire twice whenever two slices land in one frame — a Tab
 * swap would swap and swap back, and a shop would toggle open and shut. Held
 * state (movement axes, attack-held) is intentionally NOT gated: reading it
 * every slice is exactly right.
 */
/**
 * Shader warm-up.
 *
 * THIS IS THE FIX FOR THE FREEZES, and it is worth saying why it looks so odd.
 * A material's GPU program is compiled the first time it is actually drawn, and
 * on ANGLE/D3D the driver defers that work until the draw call — so the cost
 * lands in the GPU process a frame or two after three links the program, as a
 * stall with no CPU time in it at all. Measured on an RTX 3070 Ti: a burst of
 * 14 links when the support beast first cast a skill at 7.2 s was followed at
 * 7.7 s by a 499 ms frame, 476 ms of which was outside our own callback.
 *
 * So: draw one of everything now, while the player is still looking at an empty
 * canvas, and pay the whole bill up front. The camera is parked on a staging
 * spot far under the world for the duration — these frames are rendered before
 * the first gameplay frame is presented, and nothing is on screen to disturb.
 *
 * The light sweep is the non-obvious half. Program keys include the number of
 * visible lights, so the count has to be walked from 1 to the pool's maximum,
 * one render each; otherwise the second and third simultaneous projectile each
 * trigger their own recompile mid-fight.
 */
const _warmPos = new THREE.Vector3();
const _warmQuat = new THREE.Quaternion();
const _warmStage = new THREE.Vector3();

/**
 * ONE warm-up render: park the camera on `stage`, add `lights` pool lights,
 * draw, put the camera back.
 *
 * Split out of warmUpShaders() because a ZONE TRANSITION needs exactly the same
 * work done against a different world, and it cannot afford to do it all in one
 * frame the way boot can. ZoneManager calls this once every third frame while
 * the destination is preloaded and the hero is still walking, so the whole sweep
 * costs one extra scene render on ~11 frames instead of a 400 ms stall on the
 * frame he crosses the threshold.
 *
 * `lights` is how many to ADD, not a target count: at boot nothing expires
 * between calls so the counts accumulate 1..10, and during a transition the
 * previous step's lights have expired by the time the next one runs (see
 * WARM_STRIDE), so k added is k visible. Both give the sweep every count.
 *
 * The sun focus moves with the camera and back again. It is not cosmetic: the
 * shadow frustum is what decides which casters get a depth pass, so warming a
 * world outside it would link its colour programs and leave every depth program
 * to be linked on arrival — the same stall, one pass later.
 */
function warmUpFrame(stage: THREE.Vector3, lights: number, effects = false): void {
  _warmPos.copy(engine.camera.position);
  _warmQuat.copy(engine.camera.quaternion);
  // A HIGH, WIDE view rather than a ground-level one.
  //
  // Programs do not care where the camera is, but BUFFER UPLOADS do: three
  // uploads a geometry's vertex data on its first DRAW, and a draw only happens
  // if the object survives frustum culling. Warming a zone from eye level at its
  // spawn uploads the six or seven chunks in that 55-degree cone and leaves the
  // rest to arrive on the frame the hero walks in. 250 up and 40 back frames the
  // hold's whole 160x160 footprint (spawn is in a corner room) well inside the
  // 600-unit far plane, so every chunk is drawn at least once during the
  // approach.
  //
  // Honest note: this did NOT remove the one residual stall after a transition
  // — a ~320 ms frame a few frames past arrival, with under 10 ms of CPU in it.
  // That one survived every suspect tried (shadows off, enemies off, disposal
  // at 1 chunk per frame instead of 6, disposal skipped altogether, this wide
  // view), only appears in long sessions, and has a smaller twin (~107 ms) in
  // sessions with no zone change at all. What is left that fits is a major GC:
  // both chunk meshers build their vertex data in plain `number[]`, and a zone
  // built in one burst is megabytes of it. Fixing that means preallocating the
  // meshers, which is a separate job.
  engine.camera.position.set(stage.x, stage.y + 250, stage.z + 40);
  engine.camera.lookAt(stage.x, stage.y, stage.z);
  engine.updateSunFocus(stage);
  if (effects) combat.warmUp(stage, 0);
  // A dropped shard and the effect set on every step, so their materials are
  // drawn at every light count too — a zone entered without them is a zone that
  // links their programs the first time something dies in it. The drop is
  // retired again immediately below (a warm-up that runs mid-game must not
  // disturb loot lying on the ground elsewhere) and the effects are staged
  // inside the floor. `effects` on top of that is the BOOT path, which
  // additionally wants the projectile and its light.
  if (!effects) combat.warmUpEffects(stage);
  combat.warmUpDrop(stage);
  for (let i = 0; i < lights; i++) combat.warmUpLight(stage);
  engine.render();
  combat.endWarmUpDrop();
  engine.camera.position.copy(_warmPos);
  engine.camera.quaternion.copy(_warmQuat);
  engine.updateSunFocus(player.position);
}

/** VFX light pool cap. The sweep below has to cover every count up to it. */
const WARM_POOL = 10;

/**
 * How many staged renders `warmUpSteps` will yield, known before it runs.
 *
 * The boot progress bar needs a denominator, and counting the sweep's own terms
 * is the only honest one: it grows with the settlement plan, so a seed that
 * sites three towns must not silently make the bar stop at two thirds.
 */
function warmUpStepCount(): number {
  return WARM_POOL + world.towns.all.length + world.towns.roads.length + 1;
}

/**
 * The warm-up sweep, one staged render per `yield`.
 *
 * A GENERATOR rather than a plain function because the same sweep is now driven
 * two ways and must stay ONE sequence: the staged boot drains it a few steps at
 * a time so the progress bar keeps moving and the page keeps painting, and
 * `menu=0` / photo mode drain it in a single loop exactly as before. Splitting
 * it into two implementations is how the two would drift, and this one is the
 * expensive, carefully ordered part of boot — see `warmUpShaders`.
 */
function* warmUpSteps(): Generator<void> {
  // The camera has to be looking at the REAL WORLD, not at an empty staging
  // area. The light sweep below only recompiles materials that are actually
  // drawn, and the materials that matter — terrain, props, water, beasts, the
  // shop — are the world's. An earlier version staged this 400 units under the
  // map, which warmed the effects beautifully and left every lit surface in the
  // game to recompile later; the 12-program burst simply moved.
  _warmStage.copy(world.spawnPoint);
  _warmStage.y += 1;

  // One of everything, drawn once. This also takes the first pool light (the
  // projectile's), so the sweep below starts from a count of 1.
  warmUpFrame(_warmStage, 0, true);
  yield;

  // Then one light at a time, one render each, to the pool's cap. EXACTLY one:
  // adding two per pass leaves every odd count uncompiled, which is a real bug
  // this code already had — three projectiles in flight at once then hit an
  // unseen count mid-fight and recompiled twelve materials in one frame.
  //
  // The `yield` between counts is free here and NOT the same lever as the zone
  // warm-up's WARM_STRIDE: nothing is expiring between these steps at boot (see
  // warmUpFrame's note on `lights` accumulating), so a step may follow the last
  // one immediately or a frame later and the count it renders at is identical.
  for (let i = 1; i < WARM_POOL; i++) {
    warmUpFrame(_warmStage, 1);
    yield;
  }

  // THE TOWNS AND THE ROADS. They are built at world creation and stand
  // hundreds of units from spawn, so the staged render above — a 250-unit-high
  // view framing roughly a 130-unit radius — never draws them.
  //
  // Two costs would otherwise land on the frame the player first sees the camp.
  // The obvious one is the GLOW material (the only new program this whole
  // feature adds): campfire, braziers, lamps and the forge share it, and it is
  // linked the first time any of them is drawn. The bigger one is BUFFER
  // UPLOAD — three uploads a geometry's vertex data on its first draw, and the
  // Encampment alone is ~100k vertices — which is the same reason warmUpFrame
  // stages a zone from high and wide rather than from eye level (see its note).
  //
  // One frame per site is enough: an upload is per GEOMETRY, not per triangle in
  // frustum, so a mesh drawn at all is a mesh fully resident.
  for (const t of world.towns.all) {
    _warmStage.set(t.x, world.getHeight(t.x, t.z) + 1, t.z);
    warmUpFrame(_warmStage, 0);
    yield;
  }
  for (const r of world.towns.roads) {
    const m = Math.floor(r.path.length / 6) * 3;
    _warmStage.set(r.path[m], r.path[m + 1] + 1, r.path[m + 2]);
    warmUpFrame(_warmStage, 0);
    yield;
  }
  _warmStage.copy(world.spawnPoint);
  _warmStage.y += 1;

  // The two underwater programs (screen tint, bubbles). They are drawn by
  // nothing above — the camera is in the air at boot, so the sweep never touches
  // them — and the frame they would otherwise link on is the frame the hero's
  // head goes under, which is a stall in the middle of a swim.
  underwater.warmUp(() => engine.render());
  yield;

  // NOT renderer.compile(scene, camera). It was tried and measured: it linked
  // 117 programs in one go and made boot dramatically WORSE (593 ms, 429 ms and
  // 287 ms stalls in the first 1.5 s, against ~110 ms without it), because it
  // links every permutation in the graph whether or not it will ever be drawn,
  // and the driver then compiles the lot. Drawing one of each thing, as above,
  // is both cheaper and closer to what the GPU actually needs.

  // Expire everything the warm-up spawned: every effect above was given a life
  // measured in hundredths of a second, so one long update clears the lot.
  //
  // AFTER the last yield on purpose. Whatever the sweep left burning has to be
  // cleaned up by the same pass that lit it, not left to a caller that might
  // stop draining early — and no caller does, which is what makes putting it
  // here safe rather than merely tidy.
  combat.update(5, player as unknown as Damageable, []);
}

/** Drain the whole sweep now. The unstaged boot path; see `warmUpSteps`. */
function warmUpShaders(): void {
  for (const _ of warmUpSteps()) { /* every step, one task */ }
}

/** Set by the shop-proximity test, read by the hint decision after the zone update. */
let nearShop = false;
/** The NPC in talk range this slice, or null. Same contract as `nearShop`. */
let nearNpc: NpcInfo | null = null;

/**
 * One composed talk prompt per NPC, built the first time he is walked up to and
 * kept.
 *
 * The same argument as SKILL_DEN_HINT above — the pill is HTML and the key cap
 * arrives inside `{key}`, so composing it is a `t(key, vars)` call that
 * allocates — but it cannot be one hoisted constant, because the sentence names
 * the person. One entry per NPC in the game is the whole cache; it is written
 * once each and read on every slice the player is stood in front of somebody.
 */
const npcHints = new Map<string, string>();
function npcHint(npc: NpcInfo): string {
  let html = npcHints.get(npc.id);
  if (html === undefined) {
    html = t('hint.npcTalk', { key: hud.interactPrompt, name: t(npc.nameKey) });
    npcHints.set(npc.id, html);
  }
  return html;
}
/** The dialogue panel's footer. Composed like the hints above. */
let dialogueFoot = '';

/**
 * Re-compose every prompt this file hoisted out of the frame loop.
 *
 * The exhaustive list, and the only writer of all three. Two things invalidate
 * them and neither is per-frame: the display language, and the DEVICE — each of
 * these sentences has a key cap baked into it, and that cap is `E` on a keyboard
 * and a controller face on a pad. `kbd('E')` is gone from the call sites for
 * that reason; `hud.interactPrompt` is whichever the HUD is currently printing,
 * so all four surfaces (hotbar, mount ring, shop footer, these pills) name one
 * device at a time.
 *
 * The per-NPC cache goes with them: it is keyed by person, so nothing in it
 * notices either change on its own.
 */
function composeKeyHints(): void {
  const key = hud.interactPrompt;
  skillDenHint = t('hint.skillDen', { key });
  dialogueFoot = t('npc.dialogue.close', { key });
  npcHints.clear();
}
composeKeyHints();

/**
 * How far a wild beast can be and still be worth reporting to the world.
 *
 * Past 24 units it cannot win one of the sway field's six slots against the
 * party standing on top of the camera, so reporting it is pure cost. One
 * squared distance per enemy per slice buys the whole cull.
 */
const DISTURB_RANGE2 = 24 * 24;

/**
 * Tell the world what is moving through it this slice — see `World.disturb`.
 *
 * Composition-root policy, which is why it is here and not in any subsystem:
 * the world does not know what a beast is, combat does not know what the hero is,
 * and this is the one place that knows all of them. Called after the beasts have
 * moved so their positions are the current ones, and before `zones.update`, so
 * the cost lands in the `world` profiler section next to the field it feeds.
 * The wild pack is a slice stale by construction — `combat.update` runs at the
 * end of the slice — which at 60 Hz is 16 ms of lag on an effect whose own
 * smoothing is measured in hundreds of milliseconds.
 */
function reportMovers(): void {
  if (!flags.props) return;
  const ridden = mount.beast;
  if (ridden) {
    // The saddle, not the rider. A mounted hero's own position is a metre above
    // his mount's feet, and reporting THAT would read to the clearance test as a
    // body hovering — a galloping boarhound would blow the grass instead of
    // trampling it. The ridden beast is deliberately not reported again below.
    world.disturb(-1, ridden.position.x, ridden.position.y, ridden.position.z,
      ridden.scaledRadius, ridden.species.locomotion === 'flying' ? 'fly' : 'walk');
  } else {
    world.disturb(-1, player.position.x, player.position.y, player.position.z,
      player.radius, 'walk');
  }
  if (flags.beasts) {
    const p0 = primary();
    const p1 = support();
    if (p0 !== ridden && !p0.isDead) {
      world.disturb(-2, p0.position.x, p0.position.y, p0.position.z, p0.radius,
        p0.species.locomotion === 'flying' ? 'fly' : 'walk');
    }
    if (p1 !== ridden && p1 !== p0 && !p1.isDead) {
      world.disturb(-3, p1.position.x, p1.position.y, p1.position.z, p1.radius,
        p1.species.locomotion === 'flying' ? 'fly' : 'walk');
    }
  }
  // Wild beasts part the grass too. Their id is their root Object3D's, three's own
  // monotonic counter and the only handle an Enemy has that survives a respawn
  // of the one beside it; the party's reserved ids are negative precisely so
  // they cannot collide with it.
  for (const e of combat.enemies) {
    if (e.isDead) continue;
    const dx = e.position.x - player.position.x;
    const dz = e.position.z - player.position.z;
    if (dx * dx + dz * dz > DISTURB_RANGE2) continue;
    world.disturb(e.root.id, e.position.x, e.position.y, e.position.z, e.radius,
      e.species === 'peckit' ? 'fly' : 'walk');
  }
}

function simulate(dt: number, first: boolean, interactive: boolean): void {
  // An open console is a modal: it has the keyboard, so the hero must not also
  // act on it. Same treatment the shop already gets — and the F1 controls sheet,
  // which is the same bargain read the other way round: a player who stopped to
  // find out what a key does must not have walked off a cliff while reading.
  const modal = hud.isShopOpen() || hud.isControlsOpen() || pauseMenu.isOpen
    || !!devConsole?.isOpen;
  nearShop = false;
  nearNpc = null;
  // Whose contact the particle system tests this slice, or null. It integrates
  // on EVERY slice either way — a modal overlay freezes the hero, not the leaves
  // already falling behind it — so only the contact test needs someone to test.
  let toucher: Player | null = null;

  // The camera stick is a rate control, so it must inject its look delta BEFORE
  // the player/camera update consumes mouseDX this frame — ticking it later in
  // the frame meant endFrame() wiped the delta before the camera ever saw it.
  if (interactive && !modal) touch?.update(dt);

  // Photo mode drives the camera and the subject itself and must not have the
  // player controller or the HUD fighting it, but it DOES need the world to
  // stream and the beasts to animate — everything below the branch.
  if (!interactive) {
    // fall through to the world update
  } else if (!modal) {
    perf.section('input');
    // Mounting runs BEFORE the player: while a beast is being ridden it writes
    // the hero's position, velocity and saddle pose for this slice, and
    // player.update() then animates and frames him from those. It is safe on
    // every slice — the F edge is latched inside the controller, not read from
    // input.pressed(). `flags.beasts` gates it because a hidden party has nothing
    // to climb on.
    mount.update(dt, flags.beasts ? primary() : null);
    player.update(dt);
    // The hero is the only thing that brushes the world today. A mount's gallop
    // dust would pass `mount.beast` here instead — same interface, same pool.
    toucher = player;
    perf.section('player');

    if (first) {
      // Hotbar
      const skills = hotbarSkills();
      (['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const).forEach((code, i) => {
        if (input.pressed(code) && skills[i]) castFromBeast(primary(), skills[i]);
      });

      // Beast management. Swapping is locked out in the saddle: every mounted
      // path here keys off primary() being the ridden beast — the hotbar aims
      // from it, the follow update skips it — and a Tab mid-ride would make
      // "the beast you are riding" and "the beast you are commanding" two different
      // animals for no gain.
      if (mount.isMounted) {
        if (input.pressed('Tab') || input.pressed('BracketLeft') || input.pressed('BracketRight')) {
          bus.emit({ type: 'toast', text: t('toast.dismountFirst') });
        }
      } else {
        if (input.pressed('Tab')) {
          const wasPrimary = primaryIdx; primaryIdx = supportIdx; supportIdx = wasPrimary;
          bus.emit({
            type: 'toast',
            text: t('toast.beastTakesLead', { beast: t(primary().species.nameKey) }),
          });
        }
        if (input.pressed('BracketRight')) cycleBeast('primary', 1);
        if (input.pressed('BracketLeft')) cycleBeast('support', 1);
      }
    }

    // Support beast errands + auto-cast
    const sup = support();

    fetchScanT -= dt;
    if (fetchScanT <= 0) {
      fetchScanT = FETCH_SCAN;
      if (flags.beasts && !sup.isFetching && !sup.isDead) {
        const job = combat.findFetchJob(player.position, FETCH_RADIUS, worthFetching);
        if (job) sup.beginFetch(job);
      }
    }

    if (sup.wantsSupportCast()) {
      const known = sup.knownSkillIds.map((id) => getSkill(id)).filter((s): s is SkillDef => !!s);
      const heal = known.find((s) => s.targeting === 'support' || s.targeting === 'self');
      const hurt = player.hp < player.maxHp * 0.7 || primary().hp < primary().maxHp * 0.7;
      const pick = hurt && heal ? heal : known.find((s) => s.targeting !== 'support' && s.targeting !== 'self') ?? heal;
      if (pick) castFromBeast(sup, pick);
    }

    // Shop proximity. The prompt itself is decided after the zone update below,
    // because a gateway prompt has to win: both are "you are standing on
    // something", and the gateway is the one with a countdown running.
    nearShop = world.shopPositions.some((s) => s.distanceTo(player.position) < 3.5);

    // People. `E` talks, exactly like `E` opens a den, and the two can never
    // both be in range — a den is never sited inside a town (see placeShops) —
    // but the NPC is tested first anyway so that the day one is, the person
    // wins over the building he is standing next to.
    //
    // The talk STATE lives in the world's NPC field, not here: it is what
    // decides that walking away ends a conversation, and it has the distances.
    // This is only the keyboard edge and the rendering.
    const npcField = world.npcs;
    nearNpc = npcField && !npcField.talking
      ? npcField.nearest(
        player.position.x, player.position.y, player.position.z, NPC_TALK_RANGE,
      )
      : null;
    if (first && input.pressed('KeyE')) {
      if (npcField?.talking) npcField.endTalk();
      else if (nearNpc) npcField?.talk(nearNpc.id);
      else if (nearShop) tryOpenShop();
    }
    // ESCAPE, WITH NOTHING OPEN, is one key with two meanings and they are in
    // priority order: it backs out of a CONVERSATION first, and only opens the
    // in-game menu when there is nothing smaller to dismiss. Same rule the modal
    // branch below applies, one level further out — cancel always closes the
    // topmost thing, and the menu is what is left when there is no topmost thing.
    //
    // All three devices arrive here and not just the keyboard: the pad's Start
    // taps a virtual Escape (core/gamepad.ts) and so does the touch overlay's
    // MENU button (core/touch.ts), so the edge is read in ONE place for every
    // way of pressing it.
    //
    // `pressed`, not `takePress`, because this is a SIMULATION slice — see the
    // note on takePress in core/input.ts and the F1 read further down, which is
    // the other half of that rule.
    if (first && input.pressed('Escape')) {
      if (npcField?.talking) npcField.endTalk();
      else pauseMenu.open();
    }
  } else if (first && (input.pressed('Escape') || input.pressed('KeyE'))) {
    // Cancel closes the TOPMOST modal, which is the only reason this is an
    // if/else rather than two calls: F1 can be pressed with a den open, the
    // sheet draws over it (see the wrapper order in ui/index.ts), and one press
    // of Escape must dismiss one thing. The pad reaches this too — B and Start
    // tap Escape while a modal is up, which is how a controller player closes a
    // sheet they have no button to open.
    //
    // The in-game menu goes FIRST and answers for itself: inside its settings
    // step Escape means "back to the list" rather than "close", so it is the one
    // modal here that can decline to be dismissed. `onEscape` returns whether it
    // spent the press. `KeyE` is the pad's X — confirm — so it activates the
    // focused row instead of cancelling, which is what makes a controller able
    // to work this menu with no other buttons.
    if (pauseMenu.isOpen) {
      if (input.pressed('Escape')) pauseMenu.onEscape();
      else pauseMenu.activate();
    } else if (hud.isControlsOpen()) hud.closeControls();
    else hud.closeShop();
  }

  // Contact particles. Sits between the `player` and `beasts` profiler markers, so
  // its cost is measured in the `beasts` slot — its own timing is on
  // `__dbgTouchFx().ms`, which is finer grained than a section anyway.
  touchFx.update(dt, toucher);

  // Cooldowns
  for (const [id, t] of cooldowns) cooldowns.set(id, Math.max(0, t - dt));

  // Beasts follow
  const owner = { position: player.position, velocity: player.velocity, isSwimming: player.isSwimming };
  if (flags.beasts) {
    // The ridden beast has already been placed and animated by mount.update();
    // running follow steering on top of that would fight the reins.
    const ridden = mount.beast;
    if (primary() !== ridden) primary().update(dt, owner, 'primary', roster);
    if (support() !== ridden) support().update(dt, owner, 'support', roster);
  }
  perf.section('beasts');

  reportMovers();

  // Streams the active zone, runs the gateway's arm/dwell rules, and builds and
  // warms whatever is being preloaded. It can swap `world` out from under this
  // slice (see onArrive), which is safe here: everything above has finished
  // with it, and combat below is rebound by the same call.
  zones.update(player.position, dt, first);
  perf.section('world');

  // `t()` with no placeholders returns the table's own string — one lookup, no
  // allocation — so calling it on the hint path every slice is free. Do NOT
  // put an interpolated `t(key, vars)` here; that builds a string per slice.
  // A person you can talk to outranks a building you can shop in, and both
  // yield to a gateway with a countdown running. `npcHint` is a map lookup
  // after the first sighting, so this stays allocation-free like the rest.
  const hint = portalHint ?? (nearNpc ? npcHint(nearNpc) : nearShop ? skillDenHint : null);
  if (hint) hud.showHint(hint);
  else hud.hideHint();

  // The conversation. `t()` with no placeholders is one map lookup and no
  // allocation, and the HUD compares each field before writing it, so rendering
  // this every slice costs nothing while a talk is open.
  const talk = world.npcs?.talking ?? null;
  if (talk) hud.showDialogue(t(talk.nameKey), t(talk.lineKey), dialogueFoot);
  else hud.hideDialogue();

  combat.update(dt, player as unknown as Damageable, [primary(), support()] as unknown as Damageable[]);
  perf.section('combat');
}

function frame(): void {
  // The loop OWNS ITS OWN SHUTDOWN, and this is the only way out of it. Exit
  // clears `playing` (see exitToTitle) and the next frame simply does not
  // schedule another — nothing is torn down under a frame halfway through
  // drawing it, and `beginPlay` starting the loop again is what restarts it.
  if (!playing) return;
  requestAnimationFrame(frame);
  if (!engine.beginFrame()) return;
  perf.begin();
  const dt = engine.tick();
  // Everything that owns the screen: the shop, the F1 controls sheet and the
  // in-game menu. All three stand the pad down and hide the touch overlay, for
  // the same reason — a button held when the panel opened must not stay held
  // behind it.
  const modal = hud.isShopOpen() || hud.isControlsOpen() || pauseMenu.isOpen;
  // A modal does not turn the camera, and the controls sheet is the one that has
  // to say so out loud: it keeps pointer lock (see the F1 read below), so unlike
  // the shop it goes on collecting mouse delta that no slice will spend. See
  // Input.clearLook for what that costs if it is left to pile up.
  if (modal) input.clearLook();

  // Poll the pad ONCE PER RENDERED FRAME, and before the slices below.
  //
  // Both halves matter. Look delta accumulated here behaves exactly like mouse
  // movement — integrated over wall-clock, consumed by whichever slice runs —
  // whereas polling per slice would multiply the turn rate by the slice count.
  // And the edges land before slice 0, the one `first` is true for, which is
  // what the hotbar, Tab, the beast cycles and the shop key are all gated on.
  pad?.setModal(modal || !!devConsole?.isOpen);
  pad?.poll(dt);

  // Drain the accumulator in fixed slices; carry the remainder to next frame.
  simAccumulator += dt;
  let steps = 0;
  while (simAccumulator >= SIM_DT && steps < MAX_STEPS) {
    // `interactive` is what decides whether the hero reads the input device this
    // slice, and photo mode is the only thing that turns it off now. The title
    // screen used to be the other one — the loop ran behind the poster and the
    // hero had to be stood down every slice — and it no longer needs to be:
    // `frame()` is not called until `beginPlay()` says the player is playing, so
    // there is no slice to stand down. See the boot-order note at the top.
    simulate(SIM_DT, steps === 0, !photoMode);
    simAccumulator -= SIM_DT;
    steps++;
  }
  // Hit the cap: drop the backlog rather than compound it into the next frame.
  if (steps === MAX_STEPS) simAccumulator = 0;

  if (photoMode) {
    if (params.get('beast')) {
      // Auto-frame the primary beast: 3/4 portrait tracking its live position.
      const beast = primary();
      const ang = (Number(params.get('a') ?? 35) * Math.PI) / 180;
      // Frame the subject at ~40% of frame height. Sized from the rig's own
      // extents (a small beast's ears/tail push well past its nominal height, and
      // wingspan dominates for flyers) with a hard minimum distance: at 55° FOV
      // anything closer than ~2.6 units distorts badly on a wide-angle lens.
      const subject = Math.max(0.5, beast.height, beast.radius * 2.2);
      const vFov = (engine.camera.fov * Math.PI) / 180;
      const fitDist = subject / (0.4 * 2 * Math.tan(vFov / 2));
      const dist = Number(params.get('dist') ?? Math.max(2.6, fitDist));
      const midY = beast.position.y + subject * 0.5;
      const aimY = beast.position.y + subject * 0.42;

      /** Highest camera lift needed to clear terrain along the sight line. */
      const requiredLift = (px: number, pz: number, d: number): number => {
        let need = world.getHeight(px, pz) + 0.9;
        for (let s = 1; s <= 6; s++) {
          const t = s / 7;
          const gx = px + (beast.position.x - px) * t;
          const gz = pz + (beast.position.z - pz) * t;
          const clearance = world.getHeight(gx, gz) + 0.35;
          const y = aimY + (clearance - aimY) / Math.max(0.28, 1 - t);
          if (y > need) need = y;
        }
        return need;
      };

      // Eye level with the subject's mid-height, and never more than a little
      // above it: an unbounded lift turned blocked shots into aerial specimen
      // photos looking down on the subject's back. When the sight line is
      // blocked, step CLOSER first, then swing the bearing — only accept a
      // higher camera as a last resort.
      const ceiling = midY + subject * 1.15;
      let cx = 0, cz = 0, camY = 0;
      let bestOver = Infinity, bx = 0, bz = 0, by = 0;
      outer: for (const swing of [0, 0.45, -0.45, 0.9, -0.9]) {
        for (const shrink of [1, 0.85, 0.72, 0.61]) {
          const a2 = ang + swing;
          const d2 = Math.max(1.8, dist * shrink);
          const tx = beast.position.x + Math.sin(a2) * d2;
          const tz = beast.position.z + Math.cos(a2) * d2;
          const need = requiredLift(tx, tz, d2);
          const y = Math.max(midY, need);
          const over = y - ceiling;
          if (over < bestOver) { bestOver = over; bx = tx; bz = tz; by = y; }
          if (over <= 0) { cx = tx; cz = tz; camY = y; break outer; }
        }
      }
      if (camY === 0) {
        // Nothing was fully clear — take the least-elevated candidate and cap it.
        cx = bx; cz = bz; camY = Math.min(by, ceiling);
      }
      engine.camera.position.set(cx, camY, cz);
      // Aim slightly low so the subject sits at ~0.45 frame height.
      engine.camera.lookAt(beast.position.x, aimY, beast.position.z);
      // Turn the subject to face the camera, off by 20° for a 3/4 view. This
      // must use the FINAL bearing, not the requested `ang` — the occlusion
      // search above may have swung the camera, which is how subjects ended up
      // photographed from the flank.
      beast.facingOverride = Math.atan2(cx - beast.position.x, cz - beast.position.z) - 0.35;
    } else {
      engine.camera.position.copy(photoCam);
      engine.camera.lookAt(photoLook);
    }
    engine.updateSunFocus(player.position);
    if (photoAnim) {
      photoAnimTimer -= dt;
      if (photoAnimTimer <= 0) {
        photoAnimTimer = 2.5;
        primary().playAction(photoAnim as never);
      }
    }
  }

  // HUD sync
  hud.setPlayerHp(player.hp, player.maxHp);
  hud.setBeasts(beastHud(primary()), beastHud(support()));
  const slots: SkillSlot[] = hotbarSkills().map((def) => {
    const remaining = cooldowns.get(def.id) ?? 0;
    return { def, cooldownRemaining: remaining, ready: remaining <= 0 };
  });
  hud.setSkills(slots);
  // Compass. Presentation, so it belongs here and not in simulate(): the strip
  // shows where the LENS points, and the lens is placed by this frame's camera
  // update, not by the fixed-rate sim (which may have run 0..n times above).
  // North is world -Z, the direction three's default camera looks down.
  engine.camera.getWorldDirection(_compassFwd);
  hud.setCompass(
    Math.atan2(_compassFwd.x, -_compassFwd.z) * (180 / Math.PI),
    player.position.x, player.position.z,
  );
  // Key caps or controller faces, following whatever the player LAST touched
  // rather than whether a pad has ever been used — put the controller down,
  // reach for the keyboard, and the labels come back. Cheap: returns on the
  // first line unless the device actually changed.
  //
  // The composed hint pills have a cap baked in and are not redrawn from
  // `this.prompts`, so they ride the same edge. See `composeKeyHints`.
  if (hud.setPadPrompts(input.lastSource === 'gamepad' && pad ? pad.glyphs : null)) {
    composeKeyHints();
  }
  hud.setMountHold(mount.progress);
  hud.setMounted(
    mount.beast ? t(mount.beast.species.nameKey) : null,
    mount.beast ? mount.beast.species.locomotion === 'flying' : false,
  );
  hud.update(dt);

  // Hide the touch overlay while a modal is open so it can't be tapped
  // through, and release any held virtual buttons.
  touch?.setVisible(!modal);

  // `padActive` is part of the gate, not decoration: a player on a controller
  // never clicks and never taps, so without it they would be the one player who
  // is never told what the controls are.
  if (!started && (input.pointerLocked || input.touchActive || input.padActive)) {
    started = true;
    // Whichever of those three it was, it was a real user gesture — which is
    // exactly what a browser requires before a page may make noise or buzz a
    // phone. See src/feedback/audio.ts.
    feedback?.unlock();
    bus.emit({
      type: 'toast',
      text: t(input.padActive
        ? 'toast.controls.gamepad'
        : touch?.isRevealed ? 'toast.controls.touch' : 'toast.controls.desktop'),
    });
  }

  // F1 is the player's controls sheet, F2 the developer's frame readout, and
  // both are read HERE rather than in a simulation slice because neither is a
  // gameplay action — a frame that drained no slice must still answer them.
  //
  // `takePress`, NOT `pressed`. That is the whole difference between a toggle
  // that works and one that works about half the time: an unconsumed edge
  // survives every frame until a slice drains, and uncapped that is two or three
  // frames, each of which toggles. See the note on takePress in core/input.ts.
  //
  // F1 carries the same gate `interactive` carries above, and for what is now
  // the same single reason: photo mode must render the same picture twice. The
  // title screen used to be the other half of this test and no longer needs to
  // be — `frame()` does not run until `beginPlay()`, so there is no frame in
  // which the poster is up and this line executes. (`beginPlay` also drains the
  // key latch, so an F1 pressed AT the menu cannot arrive here late either.)
  // F2 is deliberately outside the gate — measuring a capture's frame rate is
  // the one thing you want to do DURING a capture.
  if (!photoMode && input.takePress('F1')) {
    // POINTER LOCK IS KEPT, and that is the difference between this and the
    // shop. `tryOpenShop` hands the pointer back because a shop is a thing you
    // CLICK — there are buy buttons and nothing else presses them. A controls
    // sheet is a thing you READ, closed by the same key that opened it, and
    // releasing the lock for it made a one-key glance cost a click to undo:
    // press F1, read a line, press F1, then find the game deaf until you click
    // it again. The X and the scrim are still there for a player who has no
    // lock to lose (a pad player, or anyone who has not clicked yet).
    hud.toggleControls();
  }
  if (input.takePress('F2')) debug.toggle();
  // F3 is the panel F2's numbers are FOR. Deliberately not gated on photo mode
  // and deliberately not a modal — see the note at the top of ui/perf-panel.ts:
  // the whole point is to watch a working frame get cheaper, and a frozen world
  // streams nothing and animates nothing.
  if (input.takePress('F3')) perfPanel.toggle();
  // Either Alt — a keyboard has two and a player reaches for whichever is
  // nearer. Read as one edge so holding it does not strobe the pointer lock.
  if (input.takePress('AltLeft') || input.takePress('AltRight')) setCursorFree(!cursorFree);
  if (perfPanel.isOpen) {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'KeyR']) {
      if (input.takePress(code)) perfPanel.onKey(code);
    }
  }
  colliderView.update(dt);
  perf.section('hud');

  // AFTER every camera decision this frame (the player controller's, or photo
  // mode's above) and before the render: the effect keys off where the lens
  // actually ends up, and a frame late is a frame of clear water at the surface.
  underwater.update(dt, world.isWater(engine.camera.position.x, engine.camera.position.z));
  // And how bright to grade the result. There is genuinely less light down
  // there, and this is the only knob that can say so before the tone curve —
  // see UNDER_EXPOSURE in world/underwater.ts. 1.0 in the air, so it is a no-op
  // everywhere except under the surface.
  engine.setExposureScale(underwater.exposureScale);
  // The view itself — colour, murk, refraction, caustics — is a block in the
  // output pass rather than anything in the scene, because it has to run AFTER
  // the tone curve to be able to darken a sunlit lake bed at all. Same three
  // numbers the scene half uses, so the two can never disagree about how wet
  // the lens is.
  engine.setUnderwater(underwater.amount, underwater.depth, underwater.clock);

  // Every cue this frame produced, played together, once. The sim slices above
  // only QUEUED them — see src/feedback for why dispatching per slice is
  // actively wrong for rumble rather than merely untidy.
  feedback?.drain(dt);

  engine.render();
  perf.section('render');
  if (perf.enabled) {
    const programs = engine.renderer.info.programs?.length ?? 0;
    if (programs !== lastPrograms) {
      perf.count('programs', programs - lastPrograms);
      lastPrograms = programs;
    }
  }
  debug.update();

  // Input edges belong to the SIMULATION, not to the frame.
  //
  // endFrame() clears the one-shot state — pressed-this-frame keys, the attack
  // edge, accumulated mouse/wheel delta — and only a simulation slice ever reads
  // any of it. Once the sim runs at a fixed 60 Hz and the renderer runs as fast
  // as it likes, most frames drain no slice at all: at an uncapped 165 fps a
  // slice lands on barely a third of them. Clearing regardless threw the other
  // two thirds of every press away, measured at a 30% jump hit rate — you press
  // space, nothing happens.
  //
  // So hold the edges until a slice has had the chance to consume them. Mouse
  // delta wants exactly the same treatment: it is a quantity to integrate, and
  // dropping it on a slice-less frame silently scaled look sensitivity down.
  if (steps > 0) input.endFrame();
  perf.section('overlay');
  perf.end();
}

/**
 * How long a staged boot phase may hold the main thread before handing a frame
 * back, in ms.
 *
 * Nothing else is running — no simulation, no render loop, just this — so the
 * only thing this protects is the page's ability to PAINT: the progress bar, the
 * poster's CSS animations, and the menu answering a click. 10 ms keeps a 60 Hz
 * display inside its frame while still spending most of that frame on the work.
 *
 * It is a FLOOR on responsiveness, not a ceiling on the slice. The steps are
 * indivisible — one warm-up render, one chunk stage — so a step that overruns
 * simply overruns, and on this machine the light sweep's steps are a second
 * each. What the budget buys is the streaming phase, where the steps are small:
 * measured at 1193 ms with this budget against 1409 ms yielding after every
 * single `zones.update`. That gap looks small only because headless Brave runs
 * rAF unthrottled; on a vsync-limited display the one-call-per-frame form is
 * bounded by 60 calls a second against ~267 chunk stages, which is four and a
 * half seconds of doing almost nothing per frame.
 */
const BOOT_SLICE_MS = 10;

// Pay for every shader before the first gameplay frame. `warmup=0` skips it,
// which is how the freeze it prevents can be reproduced on demand.
//
// One simulation slice runs FIRST so there is something to warm: it primes the
// enemy population and teleports the beasts to the player, both of which are
// still at the origin (and so out of frame, and so uncompiled) before it.
if (params.get('warmup') !== '0') {
  simulate(SIM_DT, true, !photoMode);
  if (loading) {
    await loading.stage('shaders');
    const total = warmUpStepCount();
    let done = 0;
    let mark = performance.now();
    for (const _ of warmUpSteps()) {
      loading.step(++done / total);
      if (performance.now() - mark >= BOOT_SLICE_MS) {
        await loading.breathe();
        mark = performance.now();
      }
    }
  } else {
    warmUpShaders();
  }
}

/**
 * The streaming ring around spawn, drained to EMPTY before the game is handed
 * over — the last phase, and the one the issue behind all of this asked for.
 *
 * This is what the old `MENU_FPS` cap was really buying, and buying badly: the
 * chunk streamer spends its budget per rendered frame, so "keep rendering the
 * world behind the poster" was the only way it had of filling the ring, and it
 * paid for that with a full pass of GTAO, bloom and SMAA on every one of those
 * frames. Draining it here instead costs the chunk work and nothing else, and
 * it CONVERGES: the loop ends when there is nothing left, so the player walks
 * into a world that is finished rather than into one still popping in.
 *
 * The bound is a backstop, not a budget. `refreshQueue` fills the queue once
 * from a fixed disc around the focus and nothing moves the focus while this
 * runs, so the honest number of iterations is "however many the ring holds";
 * 4096 is far past that and is here so a future streamer that re-queues can
 * never hang the boot on a black screen.
 *
 * ONLY on the staged path. Under `menu=0` the game must start the instant it
 * can — every probe in `tools/` reads `__dbgPlayerPos` within a second of load
 * — and it streams as it plays exactly as it always has.
 */
if (loading) {
  await loading.stage('terrain');
  let mark = performance.now();
  for (let i = 0; i < 4096 && world.streaming; i++) {
    // dt 0, the same argument `ZoneManager.switchTo` drains with: this is
    // building, not simulating. A real dt here would run the world's wind and
    // water clocks forward through a loading screen nobody is watching, and
    // accumulate dwell on a gateway 34 units from a hero who has not moved.
    zones.update(player.position, 0, true);
    const loaded = world.chunksLoaded;
    loading.step(loaded / Math.max(1, loaded + world.pendingChunks));
    if (performance.now() - mark >= BOOT_SLICE_MS) {
      await loading.breathe();
      mark = performance.now();
    }
  }
}

// Phase 2 is over. Whether that means "play now" or "wait for New Game" is
// `beginPlay`'s to decide — see the handshake at the top of the file.
prepDone = true;
loading?.complete();
beginPlay();

/**
 * What the boot actually cost, phase by phase. Read-only, and the reason the
 * numbers in `STAGES` (src/ui/loading.ts) can be re-measured on any machine
 * instead of taken on trust. `playing` is the assertion tools/test-menu.mjs
 * cares about: the frame loop must NOT be running while the poster is up.
 */
(window as unknown as { __dbgBoot: () => unknown }).__dbgBoot = () => ({
  staged,
  prepDone,
  handedOver,
  playing,
  menuOpen: startMenu?.isOpen ?? false,
  stages: loading?.stageTimings ?? [],
  totalMs: Math.round(performance.now()),
});

// Profiler dump for the perf harness; null unless ?perf=1 recorded anything.
(window as unknown as { __dbgPerf: () => unknown }).__dbgPerf = () => perf.dump();

/**
 * Who is standing in this zone, where, and whether anyone is mid-conversation.
 *
 * Read-only, like every other probe here: it reports the world's own answers
 * (`World.npcs`) and cannot start or end a talk. Driving the interaction is the
 * keyboard's job — walk up and press E — and a probe that could do it instead
 * would be a test of a code path the player never takes.
 *
 * `ground` and `feet` are the check that he stands ON the trampled camp floor
 * rather than in it: they are the terrain height under him and the height his
 * root was placed at, and they must agree.
 */
(window as unknown as { __dbgNpcs: () => unknown }).__dbgNpcs = () => ({
  talking: world.npcs?.talking
    ? {
      id: world.npcs.talking.id,
      // Looked up, so `?lang=sv` reports the Swedish line the panel shows.
      name: t(world.npcs.talking.nameKey),
      line: t(world.npcs.talking.lineKey),
    }
    : null,
  all: (world.npcs?.all ?? []).map((n) => ({
    id: n.id,
    name: t(n.nameKey),
    x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(2),
    ground: +world.getHeight(n.x, n.z).toFixed(2),
    town: world.towns.nearest(n.x, n.z)?.id ?? null,
    fromTownCentre: ((): number => {
      const t0 = world.towns.nearest(n.x, n.z);
      return t0 ? +Math.hypot(t0.x - n.x, t0.z - n.z).toFixed(2) : -1;
    })(),
    // HORIZONTAL, and its companion below is the height — reported as the two
    // numbers the talk test actually asks about rather than as one slant
    // distance, because a single figure cannot show which of the two refused.
    // `abovePlayer` is negative when the hero is over him, which is issue #25's
    // whole case (measured at -36.92 on a climbing galebird).
    fromPlayer: +Math.hypot(n.x - player.position.x, n.z - player.position.z).toFixed(2),
    abovePlayer: +(n.y - player.position.y).toFixed(2),
    // What the shipped query answers RIGHT NOW, run rather than re-derived, so
    // a change to the rule shows up here instead of being asserted twice.
    inTalkRange: world.npcs?.nearest(
      player.position.x, player.position.y, player.position.z, NPC_TALK_RANGE,
    )?.id === n.id,
  })),
});

/**
 * The settled world, exactly as a quest system would see it: the registry, plus
 * the road polylines with the SURFACE height sampled under every deck sample.
 *
 * That last part is the whole assertion behind "a carved road is walkable". A
 * road's deck is a continuous surface where the rest of the world is floored to
 * whole units (see Terrain.getHeight), so what has to be shown is that walking
 * one never meets a rise the hero cannot step over: `maxStep` is the largest
 * upward change in `world.getHeight` between two points 0.25 units apart along
 * the deck, and MAX_STEP_UP is 0.5. Read-only, allocates, never called from the
 * frame loop.
 */
(window as unknown as { __dbgTowns: () => unknown }).__dbgTowns = () => ({
  spawn: {
    x: +world.spawnPoint.x.toFixed(2),
    y: +world.spawnPoint.y.toFixed(2),
    z: +world.spawnPoint.z.toFixed(2),
  },
  /**
   * What the settlements BLOCK — the same boxes /show-colliders draws, counted.
   *
   * Here and not in a probe of its own because the assertion is about the
   * registry: every entry in it, camp and hamlet alike, has to have grown
   * colliders, and a town that reports zero is one whose builder was missed.
   */
  structures: ((): unknown => {
    const b: number[] = [];
    world.debugStructures(b);
    const within = (x: number, z: number, r: number): number => {
      let n = 0;
      for (let i = 0; i < b.length; i += 6) {
        if (Math.hypot(b[i] - x, b[i + 1] - z) <= r) n++;
      }
      return n;
    };
    return {
      boxes: b.length / 6,
      perTown: world.towns.all.map((town) => ({
        id: town.id,
        boxes: within(town.x, town.z, town.radius + 4),
      })),
    };
  })(),
  /**
   * THE ROAD FURNITURE, AS A MEASUREMENT.
   *
   * "The lamps are too close to each other" and "the signposts are standing in
   * the road" (issue #15) are both statements about numbers, and these are the
   * numbers: the smallest gap between any two pieces, and how near the nearest
   * carriageway CENTRELINE any of them comes. `DECK_EDGE` is 5, so anything
   * under 5 is on the gravel; a lamp interval is 26, so the closest pair should
   * be a good fraction of that.
   */
  furniture: ((): unknown => {
    const f = world.debugFurniture();
    const roadDist = (x: number, z: number): number => {
      let best = Infinity;
      for (const r of world.towns.roads) {
        for (let i = 3; i < r.path.length; i += 3) {
          // Point-to-segment, the same test the network's own clearance runs.
          const ax = r.path[i - 3];
          const az = r.path[i - 1];
          const dx = r.path[i] - ax;
          const dz = r.path[i + 2] - az;
          const l2 = dx * dx + dz * dz;
          let u = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          if (u < 0) u = 0; else if (u > 1) u = 1;
          const d = Math.hypot(ax + dx * u - x, az + dz * u - z);
          if (d < best) best = d;
        }
      }
      return best;
    };
    let closestPair = Infinity;
    let pairAt: { x: number; z: number } | null = null;
    for (let i = 0; i < f.length; i++) {
      for (let k = i + 1; k < f.length; k++) {
        const d = Math.hypot(f[i].x - f[k].x, f[i].z - f[k].z);
        if (d < closestPair) { closestPair = d; pairAt = { x: +f[i].x.toFixed(1), z: +f[i].z.toFixed(1) }; }
      }
    }
    let onRoad = 0;
    let nearestRoad = Infinity;
    let roadAt: { x: number; z: number } | null = null;
    for (const p of f) {
      const d = roadDist(p.x, p.z);
      if (d < 5) onRoad++;
      if (d < nearestRoad) { nearestRoad = d; roadAt = { x: +p.x.toFixed(1), z: +p.z.toFixed(1) }; }
    }
    return {
      count: f.length,
      lamps: f.filter((p) => p.kind === 'lamp').length,
      posts: f.filter((p) => p.kind === 'post').length,
      closestPair: Number.isFinite(closestPair) ? +closestPair.toFixed(2) : null,
      closestPairAt: pairAt,
      /** How near a centreline the nearest piece comes. Under 5 is ON the road. */
      nearestRoad: Number.isFinite(nearestRoad) ? +nearestRoad.toFixed(2) : null,
      nearestRoadAt: roadAt,
      onCarriageway: onRoad,
    };
  })(),
  towns: world.towns.all.map((town) => ({
    id: town.id,
    // The looked-up name, so `?lang=sv` shows what the fingerpost shows. The
    // probe's own field names, and every other string it prints, stay English.
    name: t(town.nameKey),
    kind: town.kind,
    x: +town.x.toFixed(1), y: town.y, z: +town.z.toFixed(1),
    radius: town.radius,
    gate: { x: +town.gateX.toFixed(1), z: +town.gateZ.toFixed(1) },
    gateBearingDeg: +((town.gateAngle * 180) / Math.PI).toFixed(1),
    fromSpawn: +Math.hypot(town.x - world.spawnPoint.x, town.z - world.spawnPoint.z).toFixed(1),
  })),
  roads: world.towns.roads.map((r) => {
    const n = r.path.length / 3;
    let len = 0;
    let maxStep = 0;
    let maxGrade = 0;
    /** Deck samples standing over open water — i.e. the bridges. */
    const spans: Array<{ x: number; z: number; y: number }> = [];
    let prevH = world.getHeight(r.path[0], r.path[2]);
    for (let i = 1; i < n; i++) {
      const ax = r.path[(i - 1) * 3];
      const az = r.path[(i - 1) * 3 + 2];
      const bx = r.path[i * 3];
      const bz = r.path[i * 3 + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      len += seg;
      // Sample the walking surface finely, not just at the deck samples: a step
      // is a property of the surface between them.
      const steps = Math.max(1, Math.ceil(seg / 0.25));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const h = world.getHeight(x, z);
        const rise = h - prevH;
        if (rise > maxStep) maxStep = rise;
        const g = Math.abs(rise) / (seg / steps);
        if (g > maxGrade) maxGrade = g;
        prevH = h;
      }
      if (r.bridge[i - 1]) {
        spans.push({
          x: +ax.toFixed(1), z: +az.toFixed(1),
          y: +r.path[(i - 1) * 3 + 1].toFixed(2),
        });
      }
    }
    return {
      id: r.id, from: r.from, to: r.to,
      length: +len.toFixed(1),
      samples: n,
      /** Largest upward change in the walking surface over 0.25 units. */
      maxStep: +maxStep.toFixed(3),
      maxGrade: +maxGrade.toFixed(3),
      /** Deck height where it is lowest — never under the waterline. */
      minDeckY: +Math.min(...Array.from({ length: n }, (_, i) => r.path[i * 3 + 1])).toFixed(2),
      bridge: spans,
      path: Array.from(r.path, (v) => +v.toFixed(1)),
    };
  }),
});

// World surface queries at an arbitrary column, for the climbing/collision
// tests: `ground` is what blocks and supports, `trunkSolidTop` is the bole a
// tree adds to that, `structureTop` is what a settlement built there, and
// `climbTop` is what can be grabbed (bole or canopy — deliberately NOT a
// building; a palisade you can grab is a palisade you climb over).
// Read-only, and the whole point of the four being separate — see World.
(window as unknown as { __dbgWorld: (x: number, z: number) => unknown }).__dbgWorld = (x, z) => ({
  ground: world.getHeight(x, z),
  climbTop: world.climbTopAt(x, z),
  trunkSolidTop: world.trunkSolidTopAt(x, z),
  structureTop: world.structureTopAt(x, z),
});

/**
 * What you SEE at a column, as opposed to what you STAND ON.
 *
 * `__dbgWorld().ground` is the walking surface — the number the player, the
 * beasts and the camera all resolve against. This raycasts the actual scene
 * straight down and reports the geometry that was actually built there. The
 * two answering differently is a specific and nasty class of bug: the hero is
 * exactly where the physics says he should be, and he looks buried, because the
 * mesh in front of him was drawn above his feet. Nothing else in the probe set
 * could see it — every existing test compares the world against itself.
 *
 * The ray starts `above` units over the WALKING surface rather than in the sky,
 * and that is the whole trick: dropped from 400 it reports the cloud deck, the
 * canopy and every eave it passes through on the way down, none of which is the
 * ground. Starting just overhead asks the only question worth asking — what is
 * drawn right where the feet are. Returns `sink` = surface - ground, how deep a
 * figure standing there appears to be buried. Allocates and walks the whole
 * scene graph; call it from a tool, never from a frame.
 */
const _surfRay = new THREE.Raycaster();
const _surfFrom = new THREE.Vector3();
const _surfDown = new THREE.Vector3(0, -1, 0);
(window as unknown as {
  __dbgSurfaceY: (x: number, z: number, above?: number) => unknown;
}).__dbgSurfaceY = (x, z, above = 3) => {
  const ground = world.getHeight(x, z);
  _surfFrom.set(x, ground + above, z);
  _surfRay.set(_surfFrom, _surfDown);
  _surfRay.far = above + 40;
  // Sprite.raycast reads `raycaster.camera.matrixWorld` and throws on a null
  // one, and the world is full of glow sprites — so the camera has to be handed
  // over even though nothing here cares what it sees.
  _surfRay.camera = engine.camera;
  // MESHES ONLY. A ray fired through this world also collects glow sprites and
  // the drifting mote Points, and neither is something a hero can stand on or
  // be hidden behind — left in, they were all this reported.
  const hits = _surfRay.intersectObject(engine.scene, true)
    .filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
  const top = hits[0] ?? null;
  return {
    ground: +ground.toFixed(3),
    surface: top ? +top.point.y.toFixed(3) : null,
    hit: top ? (top.object.name || top.object.type) : null,
    /** How far a figure standing on `ground` is buried by what is drawn. */
    sink: top ? +(top.point.y - ground).toFixed(3) : null,
    hits: hits.slice(0, 4).map((h) => ({
      y: +h.point.y.toFixed(3), name: h.object.name || h.object.type,
    })),
  };
};

// The grass-disturbance field: the six uniform slots the shader is reading this
// frame, and the tracks behind them. `slots[].push` and `.wash` are the two
// numbers the effect is made of, and `tracks[].lag` is the distance between a
// body and its own wake — the "spreads" this exists for, as a measurement
// rather than as a claim. Null with `?sway=0` or `?props=0`.
(window as unknown as { __dbgSway: () => unknown }).__dbgSway = () => world.swayDebug?.() ?? null;

/**
 * The settlement colliders near a point, biggest first — the same boxes
 * /show-colliders draws, as numbers.
 *
 * The picture and the numbers answer different halves of the same question. A
 * capture shows whether the cages line up with the walls; this is what lets a
 * test AIM: "walk into the largest box within 20 units of the camp centre" finds
 * a hut without anything having to remember where the layout put one, and
 * without the test hard-coding a seed's coordinates. Read-only, allocates,
 * never called from the frame loop.
 */
(window as unknown as {
  __dbgStructures: (x: number, z: number, r?: number) => unknown[];
}).__dbgStructures = (x, z, r = 30) => {
  const b: number[] = [];
  world.debugStructures(b);
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < b.length; i += 6) {
    const d = Math.hypot(b[i] - x, b[i + 1] - z);
    if (d > r) continue;
    out.push({
      x: +b[i].toFixed(2), z: +b[i + 1].toFixed(2),
      hx: +b[i + 2].toFixed(2), hz: +b[i + 3].toFixed(2),
      yaw: +b[i + 4].toFixed(3), top: +b[i + 5].toFixed(2),
      ground: +world.getHeight(b[i], b[i + 1]).toFixed(2),
      dist: +d.toFixed(2),
      area: +(4 * b[i + 2] * b[i + 3]).toFixed(2),
    });
  }
  out.sort((p, q) => q.area - p.area);
  return out;
};

/**
 * The ROOF cylinders near a point, biggest first — the arches /show-colliders
 * draws, as numbers.
 *
 * `fit` is the one worth reading and the reason this exists rather than being
 * folded into `__dbgStructures`: it is how far the cylinder stands off the
 * thatch it was fitted to at its worst point, which is the entire question about
 * whether a cylinder was the right shape for a given roof. A box could not
 * report such a thing — it does not claim to follow anything. See `measureRidge`
 * in world/structures.ts. Read-only, allocates, never called from the frame loop.
 */
(window as unknown as {
  __dbgRidges: (x: number, z: number, r?: number) => unknown[];
}).__dbgRidges = (x, z, r = 30) => {
  const b: number[] = [];
  world.debugRidges(b);
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < b.length; i += 8) {
    const d = Math.hypot(b[i] - x, b[i + 1] - z);
    if (d > r) continue;
    out.push({
      x: +b[i].toFixed(2), z: +b[i + 1].toFixed(2),
      yaw: +b[i + 2].toFixed(3),
      hl: +b[i + 3].toFixed(2), r: +b[i + 4].toFixed(2),
      y: +b[i + 5].toFixed(2), ry: +b[i + 6].toFixed(2),
      fit: +b[i + 7].toFixed(3),
      crest: +(b[i + 5] + b[i + 6]).toFixed(2),
      ground: +world.getHeight(b[i], b[i + 1]).toFixed(2),
      dist: +d.toFixed(2),
    });
  }
  out.sort((p, q) => q.hl * q.r - p.hl * p.r);
  return out;
};

/**
 * Nanoseconds per `structureTopAt` at a column — the price of settlement
 * collision, measured rather than assumed.
 *
 * It exists because "do not linear-scan every collider in the world, but do not
 * build a heavyweight index for sixty boxes either" is only answerable with a
 * number. Call it in the middle of the Encampment (the worst case: a bucket with
 * something in it) and out in open country (the common case: a bounds test and a
 * failed Map.get), and the two answers together say whether the grid in
 * world/structures.ts is earning its fifteen lines.
 *
 * Read-only, allocates once, never called from the frame loop.
 */
(window as unknown as {
  __dbgBenchStructures: (x: number, z: number, n?: number) => unknown;
}).__dbgBenchStructures = (x, z, n = 200000) => {
  // Wander the sample point over a few units so the loop is not one branch
  // predicted perfectly, and so a warm cache line is not doing all the work.
  let sink = 0;
  const run = (): number => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const t = world.structureTopAt(x + (i % 97) * 0.05, z + (i % 89) * 0.05);
      if (t > sink) sink = t;
    }
    return (performance.now() - t0) * 1e6 / n;
  };
  run();                                  // warm
  const ns = Math.min(run(), run(), run());
  return { x, z, calls: n, nsPerCall: +ns.toFixed(1), sink };
};

/**
 * Every shader program three currently holds, as `type|cacheKey`.
 *
 * This is the instrument the zone warm-up was built with, and it earns its
 * place: `perf.count('programs')` says a program was linked, this says WHICH,
 * and a cacheKey is a comma-joined dump of the parameters three keys on — the
 * define set, then the light counts. Snapshot it either side of an event and
 * diff, and a stall stops being a mystery. Doing exactly that is what showed
 * that walking into the dungeon linked 25 programs at point-light counts 0 and
 * 1, because the overworld's four den lamps put a floor of 4 under every count
 * it had ever compiled. Read-only, allocates, never called from the loop.
 */
(window as unknown as { __dbgProgKeys: () => string[] }).__dbgProgKeys = () =>
  (engine.renderer.info.programs ?? []).map(
    (p) => `${(p as unknown as { type: string }).type}|${(p as unknown as { cacheKey: string }).cacheKey}`,
  );

// Zone state, and — in the same call — everything a transition is supposed to
// leave untouched. The two belong together: the only way to show that a switch
// preserved the hero's hp and a beast's level is to read them either side of the
// same event, and a probe that needs three calls to do it invites a race.
// Read-only, allocates, never called from the frame loop.
// The F3 panel's state, and a way to drive it. `set` is a TEST HOOK in the same
// sense as __dbgTp: a probe has to be able to flip a toggle and re-read the
// draw count without simulating six arrow presses to reach the right row.
(window as unknown as {
  __dbgGfx: (id?: string, value?: unknown) => unknown;
}).__dbgGfx = (id, value) => {
  if (id === undefined) {
    // COUNTED OFF THE SCENE, not off the setting — which is the only way to see
    // the failure this exists for. Grass switched off stayed off while standing
    // still and came back in patches while walking, because chunks built
    // through the immediate path never heard about the setting. A draw-call
    // delta could not see it (walking changes the chunk set anyway); a count of
    // VISIBLE grass meshes says it in one number.
    // TERRAIN IS IN HERE AND IS NOT A LAYER, deliberately. The ground cannot be
    // switched off, which is exactly why it has to be counted: the first version
    // of the layer logic assigned visibility only to the layers it recognised
    // and left everything else at whatever the last `setVisible(false)` had
    // done, so a player near a gateway got a world with no ground in it. A probe
    // that only knows the names of things it can hide cannot see that.
    const layers: Record<string, { shown: number; hidden: number }> = {
      terrain: { shown: 0, hidden: 0 },
      grass: { shown: 0, hidden: 0 },
      props: { shown: 0, hidden: 0 },
      water: { shown: 0, hidden: 0 },
    };
    engine.scene.traverse((o) => {
      const key = o.name.startsWith('chunk:') ? o.name.slice(6) : null;
      if (key && layers[key]) layers[key][o.visible ? 'shown' : 'hidden']++;
    });
    return { open: perfPanel.isOpen, values: gfx.snapshot(), layers };
  }
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  if (!opt) return null;
  if (value !== undefined) {
    gfx.set(opt.id, opt.choices ? Number(value) : Boolean(value));
    perfPanel.refresh();
  }
  return gfx.get(opt.id);
};

// The cursor: what is showing, whether the sheet decoded, and — as a TEST HOOK
// — a way to ask what a screen point would resolve to without moving a real
// mouse there. `states` is the count that proves all sixteen tiles were cut.
(window as unknown as {
  __dbgCursor: (x?: number, y?: number) => unknown;
}).__dbgCursor = (x, y) => {
  if (x !== undefined && y !== undefined) {
    // Drive the real listener rather than a copy of it, so this reports what a
    // player's mouse would get and cannot drift from it.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
  }
  return { ...cursors.debug(), free: cursorFree, known: CURSOR_STATES.length };
};

(window as unknown as { __dbgZone: () => unknown }).__dbgZone = () => ({
  ...(zones.debug() as Record<string, unknown>),
  // Live GPU-side totals, which is how "the overworld really did unload" is
  // shown rather than asserted: geometries is three's own count of live buffer
  // geometries, and it drops by the whole chunk set on a switch.
  geometries: engine.renderer.info.memory.geometries,
  programs: engine.renderer.info.programs?.length ?? 0,
  sceneObjects: engine.scene.children.length,
  player: {
    hp: +player.hp.toFixed(2),
    maxHp: player.maxHp,
    x: +player.position.x.toFixed(2),
    y: +player.position.y.toFixed(2),
    z: +player.position.z.toFixed(2),
  },
  shards: shards(),
  bag: bag.entries().map((e) => ({ id: e.def.id, count: e.count })),
  beasts: roster.map((p) => ({
    id: p.species.id,
    level: p.level,
    xp: p.xp,
    hp: +p.hp.toFixed(2),
    maxHp: p.maxHp,
    skills: p.knownSkillIds.slice(),
  })),
});

/**
 * Every body in the world that steers itself, and WHAT IT IS STANDING IN.
 *
 * "A beast walks through the hut its owner is leaning on" is the one way
 * settlement collision can come out looking worse than no collision at all, and
 * the only honest way to check it is to read where the other movers actually
 * ended up rather than to trust that they share a code path. `structureTop`
 * above a body's own feet means it is inside a wall.
 *
 * Fliers are listed with their locomotion because they are SUPPOSED to be over
 * the roof — a frostwing cruising above a hut is not a bug, and a probe that
 * cannot tell those apart would report one. Read-only, allocates, never called
 * from the frame loop.
 */
(window as unknown as { __dbgBodies: () => unknown }).__dbgBodies = () => {
  const at = (p: THREE.Vector3, feet: number): number | null => {
    const t = world.structureTopAt(p.x, p.z);
    return t === -Infinity ? null : +(t - feet).toFixed(2);
  };
  return {
    player: {
      x: +player.position.x.toFixed(2), y: +player.position.y.toFixed(2),
      z: +player.position.z.toFixed(2),
      overFeet: at(player.position, player.position.y),
    },
    // The two ACTIVE followers only: the rest of the roster is benched and
    // parked at the origin, where "is it inside a wall" means nothing.
    beasts: [primary(), support()].map((p) => ({
      id: p.species.id,
      locomotion: p.species.locomotion,
      x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2),
      z: +p.position.z.toFixed(2),
      /** Structure top MINUS the body's feet. Above ~0.5 it is in a wall. */
      overFeet: at(p.position, p.position.y),
    })),
    enemies: combat.enemies.map((e) => ({
      species: e.species,
      x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2),
      z: +e.position.z.toFixed(2),
      // ADDITIVE. Health is here so a tool can assert a swing LANDED without a
      // second probe — tools/test-aim-assist.mjs reads it either side of an
      // attack, which is the only statement about aim assist that is about the
      // game rather than about the maths.
      hp: +e.hp.toFixed(2),
      maxHp: e.maxHp,
      isDead: e.isDead,
      overFeet: at(e.position, e.position.y),
    })),
  };
};
