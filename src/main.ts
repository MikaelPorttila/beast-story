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
  EventBus, ELEMENT_COLORS, inReach, LOCOMOTION_NAME_KEYS,
  type CrownContact, type NpcInfo, type SkillDef, type Damageable,
  type ItemDef, type TownInfo, type World, type WorldBound,
} from './core/types';
import {
  Inventory, itemDef, itemName, isKnownItem, isDestructible, salvageValue,
  ITEMS, CURRENCY, BEAST_ID_PREFIX,
} from './core/items';
import { WEAPON_MODEL_IDS, type WeaponModelId } from './player/weapons';
import { t, onLanguageChange, type StringKey } from './i18n';
import { perf } from './core/profiler';
import { flags } from './core/flags';
import { DevConsole } from './ui/console';
import {
  bootstrapContent, content, factory, resolveText, MUSIC_TRACK_KIND,
  type BiomeData, type MusicData,
} from './content';
// THE ONE STATIC IMPORT OF A CONTENT PROVIDER, and it is in an entry point
// rather than inside `src/content/` on purpose — see the header of
// src/content/index.ts for the whole argument. In short: nothing under
// `src/content/` may statically reach `storage/bundled.ts`, because it uses
// Vite's `import.meta.glob` and tools/test-zfight.mjs imports game modules
// straight into plain Bun; but leaving `bootstrapContent`'s dynamic fallback as
// the ONLY route puts a chunk fetch on the boot path, measured at 15.8 ms
// against 2.4 ms for the linked form. This file and src/lab/index.ts are the two
// Vite entries, so they are the two places that may link it.
import { BundledProvider } from './content/storage/bundled';
import { contentIssues } from './core/content-bridge';
import { ColliderView } from './core/collider-view';
import { createWorld, type LandmarkProbe } from './world/index';
import { NPC_TALK_RANGE } from './world/npc';
import {
  nature, NATURE_PARAMS, type NatureAreaId, type NatureParamId,
} from './world/nature';
import { createDungeon } from './world/dungeon';
import { ZoneManager, type ZoneDef } from './world/zones';
import { Underwater } from './world/underwater';
import { TouchParticles } from './world/touch-particles';
import { Player } from './player/index';
import { MountController } from './player/mount';
import { BeastActor, registerSkillDefs } from './beasts/framework';
import { CombatSystem, SWORD_REACH } from './combat/index';
import { enemySpecies, MELEE_UP_REACH, MELEE_DOWN_REACH } from './combat/enemies';
import {
  HUD, type BeastHudInfo, type CompassMarker, type ShopOffer, type SkillSlot,
} from './ui/index';
import { StartMenu } from './ui/menu';
import { PauseMenu } from './ui/pause';
import {
  InventoryPanel,
  type InvAction, type InvEntry, type InvStat, type InventoryModel,
} from './ui/inventory';
import {
  exitFullscreen, fullscreenSupported, isFullscreen,
  installEscapeLock, keyboardLockSupported, escapeIsLocked, fullscreenSurvivesEscape,
} from './ui/fullscreen';
import { LoadingScreen } from './ui/loading';
import { MusicDirector, MUSIC_TRACKS } from './audio/music';
import { ALL_SPECIES, SKILLS, getSkill } from './beasts/registry';

const app = document.getElementById('app')!;
// BEFORE the engine, and before anything else measures itself: #app is sized
// from the custom properties this publishes, and the renderer takes its first
// size from #app. See src/core/viewport.ts for why the viewport is measured
// rather than asked for in dvh.
installViewport();
// Escape is the game's key, not the browser's: this arms the keyboard lock that
// makes that true for as long as the page is fullscreen. Installed here rather
// than beside the `requestFullscreen` call in ui/menu.ts because it is driven by
// the change EVENT and is under no gesture deadline — see ui/fullscreen.ts.
installEscapeLock();
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
 * The pad, the touch overlay and the feedback mixer, ASSIGNED further down
 * where their dependencies exist.
 *
 * `let ... = null` rather than the `const`s they used to be, and the reason is
 * the boot order above: the title screen's Settings panel is usable while the
 * game is still being built, so `onLookAxes` and `onHapticFeedback` can be
 * called before any of these has been constructed. A `const` declared later
 * in the module would be in its temporal dead zone at that moment and the hook
 * would THROW rather than harmlessly do nothing. Null is the right answer for
 * "not built yet": the menu has already persisted the choice, and all three are
 * constructed from `loadPrefs()` below, so the switch is honoured either way.
 *
 * `touch` is here for exactly that reason and no other — it was a `const` down
 * beside the world until the look-inversion setting reached it, at which point
 * a phone player flipping the switch on the title screen would have thrown a
 * ReferenceError instead of turning their camera round.
 */
let pad: GamepadControls | null = null;
let touch: TouchControls | null = null;
let feedback: FeedbackSystem | null = null;

/**
 * Whether `gfx` — a `const` several hundred lines below — has been constructed.
 *
 * The same hazard as the two `let`s above and a different shape, because that
 * one cannot be a `let ... = null`: eight call sites read it and every one of
 * them runs long after it exists. A flag lets the settings hook GUARD the
 * reference instead, which is all that is needed — a temporal dead zone is
 * about evaluating the name, so an arrow that never reaches it is safe.
 *
 * Nothing is lost by doing nothing in that window: the panel has already
 * persisted the choice, and `new Gfx()` reads storage.
 */
let gfxLive = false;

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
  // BOTH STICK DEVICES, and that is the whole of the setting: a pad's right
  // stick and the overlay's look pad are the same control on different
  // hardware, so one switch moves both. The mouse is deliberately not here —
  // see core/prefs.ts.
  onLookAxes: (a: Partial<LookAxes>) => {
    pad?.setLookAxes(a);
    touch?.setLookAxes(a);
  },
  onHapticFeedback: (on: boolean) => feedback?.setOptions({ hapticFeedback: on }),
  // Live, and unlike the two above it there is no null to guard: the music is
  // built BEFORE the menu, because the poster is the first thing it plays under.
  onVolume: (v: number) => music.setVolume(v),
  // The Graphics tab flips the SAME switches the F3 panel does — one model, one
  // set of keys (core/gfx.ts). The panel has already stored the value; this is
  // the apply half, and it is guarded because the sinks below drive an engine
  // and a world that do not exist while the title screen is still booting. A
  // change made in that window is read back by the constructor.
  onGraphics: (id: keyof GfxSinks, on: boolean) => { if (gfxLive) gfx.set(id, on); },
};

/**
 * THE MUSIC, built before anything else it might play under.
 *
 * Ahead of the title screen because the splash track is the title screen's, and
 * a director constructed after the poster would start it a phase late. It is
 * the one system in this file with nothing behind it — no engine, no world, no
 * DOM of its own — so there is nothing to be early FOR it.
 *
 * The volume resolves the same way every other overridable preference in this
 * file does, `flag ?? pref` — with one addition that is not in the others:
 * `flags.silentBoot`. A run under `menu=0` or `photo=1` is a probe or a staged
 * capture, and neither has anyone listening to it; muting those by default is
 * what makes "debug sessions are muted" a property of the build rather than a
 * parameter twenty tools have to remember (see core/flags.ts, and the note in
 * AGENTS.md). `?vol=0.01` is how a change that needs to hear something turns it
 * back on for one load.
 */
const music = new MusicDirector(
  flags.volume ?? (flags.silentBoot ? 0 : loadPrefs().volume),
  (scene) => musicPlaylist(scene),
);

/**
 * WHAT AN AREA PLAYS — the one place the content registry and the audio element
 * meet, and the resolver `MusicDirector` calls on every scene change.
 *
 * A function declaration rather than a const, deliberately: it is referenced by
 * the director constructed immediately above and is not CALLED until
 * `setScene`, so hoisting is what lets the two read in the order a reader wants
 * them (the director first, the policy after) instead of the order the temporal
 * dead zone would insist on.
 *
 * THE TITLE SCREEN SHORT-CIRCUITS, and that is the whole reason it is not
 * content. `music.setScene('title')` runs about forty lines below this and
 * `bootstrapContent()` runs three hundred lines further on — measured, the
 * poster is up at ~221 ms and content boots inside the `world` phase — so a
 * poster asking the registry anything would be asking an empty one. It would
 * then take the FALLBACK, which is the overworld's song, and the player would
 * hear half a second of the wrong track before the right one swapped in. The
 * splash is not an area; see the header of src/content/types/music.ts.
 *
 * A TRACK NAME NOTHING REGISTERED IS DROPPED IN SILENCE HERE, which is the one
 * place in this function that looks like a swallowed error and is not: the
 * `music-track` factories are registered before `bootstrapContent()`, so the
 * cross-asset pass has already filed an `unknown-factory` diagnostic naming the
 * asset AND the index inside its `tracks` list (content/types/music.ts). Filing
 * a second one per scene change would print the same finding every time the
 * player walks through a gateway.
 */
function musicPlaylist(scene: string): readonly string[] {
  if (scene === 'title') return [MUSIC_TRACKS.title];
  // The area's own playlist, or the one asset that volunteered to cover the
  // areas nobody scored. `undefined` for both means content is not loaded yet
  // (or a package with no music at all), and silence is the honest answer.
  const asset = content.get<MusicData>(`music:${scene}`)
    ?? content.all<MusicData>('music').find((m) => m.data.fallback);
  if (asset === undefined) return [];
  const out: string[] = [];
  for (const name of asset.data.tracks) {
    const url = factory<string>(MUSIC_TRACK_KIND, name);
    if (url !== undefined) out.push(url);
  }
  return out;
}

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

// The splash track, from the frame the poster goes up. Nothing starts when
// there is no poster: the unstaged paths go straight to `beginPlay`, which asks
// for the overworld's, and a photo run has `silentBoot` set anyway.
if (startMenu) music.setScene('title');

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
  // SCENE CHANGE: the splash track is faded out and unloaded, the overworld's
  // starts. New Game is also the gesture that makes noise legal at all on a
  // page nobody had touched — a title track the autoplay policy refused is
  // dropped rather than faded, so what the player hears is the overworld
  // starting and never a second of the poster's music behind them.
  music.setScene('overworld');
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
 * The in-game menu: F10, the HUD's menu button, the pad's Start, and the touch
 * overlay's MENU.
 *
 * Built here rather than lazily on the first press, because it is the composition
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
  // TAKING THE POINTER BACK IS SAFE AFTER A CLICK AND IS NOT AFTER A KEY, and
  // the difference is what the BROWSER is still doing with that key. Where
  // Escape is ours (the keyboard lock is held) the browser is spending nothing
  // and this is the same call it always was. Where it is not, the Escape that
  // closed this menu is at that moment also leaving fullscreen — which releases
  // the pointer lock 8 ms later, measured — so a lock taken here is one the
  // browser knocks straight back out, and that loss reads as a fresh Escape.
  // The menu closed and reopened on its own. There is nothing to take back
  // after a key: the next click does it, as it always has (see
  // `Input`'s mousedown listener).
  onClose: (by) => {
    if (isTouchPrimary()) return;
    if (by === 'click' || escapeIsLocked()) input.requestLock();
  },
  onExit: () => exitToTitle(),
});

/**
 * THE POINTER A BROWSER TOOK — nothing to do here any more, and that is the
 * change worth reading.
 *
 * This used to tap a virtual Escape. The reasoning was sound while Escape was
 * the menu key: a page holding pointer lock is never GIVEN that key (the
 * browser spends it on the lock), so the loss was the only evidence the press
 * happened, and without it the menu opened every other time. The menu is F10
 * now, which arrives as an ordinary key on every browser, so there is no
 * missing edge left to reconstruct — and reconstructing one anyway is how a
 * player who pressed Escape to close a panel got a menu they never asked for.
 *
 * The loss is handled where it belongs instead: `Input.armRelock` puts the
 * pointer back when the player starts moving again. That is a separate
 * mechanism with its own gate (`autoRelock`, set in `frame()`), and it is armed
 * from the same event this hook reads.
 */

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
 * CONTENT SPLITS DOWN THAT SAME LINE, and the split is the whole of the content
 * design's §12.3. The STATE — every flag set, every quest started, every point
 * of interest discovered — is a play session and is thrown away with the rest.
 * The DEFINITIONS are not: which towns exist, who Gain is and what a Gloopling
 * is worth are pure functions of the build, exactly as the terrain is a pure
 * function of the seed, and nothing about them is per-session. So the packages
 * stay LOADED and the `boot` lease is never released — releasing it would drop
 * the graph the world standing behind this poster was cut from and make the next
 * New Game rebuild it for no gain at all.
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
  // Back to the splash track. The zone's is faded and UNLOADED on the way — a
  // session that ended is a track nothing is going to play again, and leaving it
  // paused-but-loaded is a buffer and a decoder held for the rest of the page's
  // life. See src/audio/music.ts.
  music.setScene('title');

  // Back to the overworld first, because the reset below places the hero at
  // `world.spawnPoint` and a player who quit inside the dungeon would otherwise
  // spawn a new game in it. The switch rebinds every `bound` subsystem, which is
  // what makes the following three lines resolve against the right heightfield.
  if (zones.id !== 'overworld') zones.switchTo('overworld');

  player.reset();
  mount.dismount();
  combat.reset();
  // The facts, not the definitions — see the note above.
  content.state.reset();
  for (const b of roster) b.reset();
  primaryIdx = 0;
  supportIdx = 6;
  refreshVisibility();
  cooldowns.clear();
  spent = 0;
  bag.clear();
  inventory.close();
  // The loadout is session state like everything above it, and `attackStat` is
  // the one field of it that lives on an object whose own `reset()` deliberately
  // does not touch it — see BASE_ATTACK. `giveStartingKit` re-equips and calls
  // `applyLoadout`, so the next game starts on the same numbers the first did.
  equippedWeapon = null;
  attackBuff = 0;
  attackBuffT = 0;
  giveStartingKit();
  fetchScanT = 0;
  nearShop = false;
  nearNpc = null;
  world.npcs?.endTalk();
  hud.closeShop();
  hud.closeControls();
  hud.reset();
  touch?.setVisible(true);
  // The frame loop is the only writer while a game is running, and it has just
  // stopped: left true, the title screen would answer a mouse moved across the
  // poster by grabbing the pointer back off the New Game button.
  input.autoRelock = false;

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
// CONTENT, and it is the first thing in the world phase rather than a phase of
// its own.
//
// It has to be BEFORE `createWorld`, because `planSettlements` reads
// `content.all('town')` to know what to site and the whole of world creation
// runs off that. It is INSIDE the world stage rather than beside it because it
// costs nothing worth a chip: measured on the dev server at 1280x800 it is
// 2.4 / 2.5 / 2.3 ms (`__dbgContent().bootMs`) against a `world` stage of
// ~390 ms and a shader sweep of ~10 s, so it disappears into the noise of
// cutting three towns and their roads. A progress step a player cannot see the
// needle move on is a step that makes the boot look slower than it is.
//
// It does not throw. `ok === false` means something in the package is broken and
// the world will come up short of a town or an enemy; `__dbgContent()` and
// `/content check` are where the findings are read, which is the same bargain
// every other diagnostic in this project strikes — degrade with a placeholder
// and say so, rather than refuse to start.
//
// `engineFlags` names the flags ENGINE code sets that no content ever writes,
// because the reachability check cannot see a `setFlag` in this file and would
// otherwise report each one as a quest that can never start. There are none yet;
// the argument is here so the first one has somewhere to go.
const contentBootStart = performance.now();
content.addProvider(new BundledProvider());
// THE TRACK FACTORIES, AND THEY HAVE TO BE ABOVE THE BOOT. Registering one also
// publishes its name to the content type that validates against it (see
// `FACTORY_PUBLISHERS` in content/index.ts), and the cross-asset pass runs
// inside `bootstrapContent` — so a registration after this line is a set of
// names the validator never saw, and `"tracks": ["overwrold"]` would load
// clean and play nothing. Same rule and the same ordering as the town layouts,
// npc bodies and enemy models, which register in their own modules at import.
// A URL rather than a builder is the whole value here: content names a song and
// never a path, so a package can never choose what the page fetches.
for (const [name, url] of Object.entries(MUSIC_TRACKS)) {
  content.defineFactory(MUSIC_TRACK_KIND, name, url);
}
/**
 * THE SEAM A QUEST TURN-IN LANDS ON: content may put an item in the bag.
 *
 * `{ "do": "item.give", "item": "gain-token", "count": 1 }`, in any action list
 * — a dialogue entry's, a quest's `onComplete`. It is the only way a QUEST item
 * is reachable in ordinary play, which is deliberate: a quest item that fell off
 * a gloopling is a quest item nobody designed (see the drop table in
 * combat/index.ts), so the catalogue holds one and the shipped content hands out
 * none yet.
 *
 * ABOVE `bootstrapContent`, for the reason the factory loop above gives: the
 * cross-asset pass runs inside it and reports an action no `defineAction`
 * registered, so a registration after this line is a handler the validator never
 * saw. It VALIDATES ITS OWN PARAMS AND REPORTS rather than throwing, which is
 * content/actions.ts's rule for every handler — a malformed action in a package
 * must be one thing that did not happen, not a dead UI.
 *
 * `bag` and `refreshBagChips` are further down the file and are reached through
 * a hoisted declaration; nothing calls this until content is running, which is
 * long after both exist.
 */
content.defineAction('item.give', (params) => {
  const id = params.item;
  if (typeof id !== 'string' || !isKnownItem(id)) return;
  const raw = params.count;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
  giveItemFromContent(id, n);
});
const contentBoot = await bootstrapContent({ engineFlags: [] });
/** What the phase above cost. Reported by `__dbgContent`; see the note there. */
const contentBootMs = performance.now() - contentBootStart;

/**
 * The biomes' vegetation multipliers, applied before the first chunk is built.
 *
 * EVERY SHIPPED VALUE IS EXACTLY 1, AND `setArea` DELETES AN ENTRY SET TO 1 —
 * so this loop leaves `nature`'s tables empty, `isDefault()` true, and
 * `tools/test-nature.mjs`'s identity control reading a drift of 0. The migration
 * cannot move a blade of grass, and it cannot by CONSTRUCTION rather than
 * because the numbers happen to match (src/content/types/biome.ts says the same
 * from the other end). Verified by running the probe.
 *
 * Here rather than in world/index.ts because this is where `nature` is already
 * wired to the streamer, and BEFORE that wiring: `setArea` fires the change
 * listener, and there is no world to rebuild yet — which is the point, since the
 * densities have to be in place before the first chunk rather than pushed into
 * one that already exists.
 *
 * The area key is the biome id's name half. Unvalidated against `BiomeId`, for
 * the same reason `/nature` and `?nature=` leave it unvalidated (world/nature.ts,
 * `readUrl`): the set of named areas widens as the world grows, and an override
 * that changes nothing is a better failure than a refusal that hides one.
 */
for (const biome of content.all<BiomeData>('biome')) {
  const area = biome.id.slice(biome.type.length + 1) as NatureAreaId;
  for (const [param, value] of Object.entries(biome.data.nature)) {
    nature.setArea(area, param as NatureParamId, value);
  }
}

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
    // THE ONE POINT OF INTEREST THAT ASKS FOR A KEEP-OUT, and it is a designer's
    // call rather than something a landmark gets for being one — see the
    // `landmarks` argument of createWorld and `SafeZone` in core/types.ts. The
    // arch is a THRESHOLD: a player walks up to it, waits out a preload and
    // crosses, and an animal that materialised beside them while they were being
    // held there is an ambush the game arranged, not one they walked into. 12
    // covers the arch and the pace or two either side of it; anything hunting
    // them still follows them right up to it and through.
    return [{ ...gateSite, id: 'landmark:gateway', noSpawnRadius: 12 }];
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
    // The other scene change, and the only one that is not the session starting
    // or ending. A ZONE ID IS A SCENE NAME now — `musicPlaylist` looks for
    // `music:<id>` and takes the fallback playlist when no package scored this
    // area — so a zone added later brings its music with it and this line never
    // grows a branch. It used to be a ternary mapping everything that was not
    // the overworld onto `hold`, which is a two-zone game written down.
    music.setScene(def.id);
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
// The HUD's menu button TAPS THE KEY, exactly as the pad's Start and the touch
// overlay's MENU do — see the note where the button is built. The one reader in
// `frame()` still decides what it means, so the button toggles the menu and
// closes the topmost panel without knowing that either is a rule.
hud.onMenu = () => input.tapVirtual('F10');

// THE OPENING SHOT: beside the start town's greeter, at his fire, facing the
// way he faces, with the camera on the hero's face. It is a POSE and not a
// point (see `World.playerStart` in core/types.ts), which is why this is one
// call rather than a `position.copy` — the facing is half the composition, and
// `Player.reset()` goes through the same method so a second New Game in one
// session opens on the same shot.
player.takeStartPose();
/**
 * THE SWING, OR THE SHOT — decided by what is in his hand, here rather than in
 * `Player`.
 *
 * Which weapon is equipped is gear-slot policy and lives in this file with the
 * rest of it (see `applyLoadout`); the hero controller knows only that he
 * attacked, and combat knows only how to do each. `player.weapon` is read off
 * the RIG, so this can never disagree with the model on screen.
 *
 * A bow's arrow goes where the swing would have gone: `dir` is the hero's aim,
 * already resolved by the player controller, and the aim assist above steers it
 * exactly as it steers a sword — the difference is reach and a projectile,
 * which is `arrowStrike`'s business.
 */
player.onAttack = (origin, dir) => {
  if (player.weapon === 'bow') combat.arrowStrike(origin, dir, player.attackStat);
  else combat.meleeStrike(origin, dir, player.attackStat, player.position.y);
};

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
  const target = combat.bestMeleeTarget(
    origin, _aimDir, SWORD_REACH, AIM_ASSIST_CONE_COS, player.position.y,
  );
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
/**
 * The town chips that have to be re-read every frame, paired with the town.
 *
 * A TOWN THAT MOVES IS THE CASE `CompassMarker` ALWAYS ALLOWED AND NOTHING HAD
 * EXERCISED. The chip is anchored to a world position, and the HUD reads that
 * position off the marker OBJECT every frame — so keeping the object and
 * writing two numbers into it is the whole of "the compass is aware of the
 * town's updated location" (issue #68). It costs two assignments per town per
 * frame and no DOM work at all: `setCompass` already guards every write on a
 * tenth of a pixel of movement, so a settlement that is standing still touches
 * nothing.
 *
 * Every town rather than only the flying one, because "which of these moves" is
 * not on `TownInfo` and should not be: a registry entry's position is live by
 * contract, and a list that had to be told which members meant it would be the
 * next thing to go stale.
 */
const _townChips: Array<{ chip: CompassMarker; town: TownInfo }> = [];

function syncCompassMarkers(w: World, gateX: number, gateZ: number, gateHex: number): void {
  _townChips.length = 0;
  hud.setCompassMarkers([
    // Dens in the shard-shop amber the hint pill and price tags already use.
    ...w.shopPositions.map((s, i) => ({ id: `den${i}`, x: s.x, z: s.z, color: 0xffd23f })),
    // TOWNS, straight off the registry — one line, and it is the same list a
    // quest would enumerate. The chip points at the GATE rather than the centre
    // because that is where you actually have to arrive, and it carries the
    // town's own colour so the strip distinguishes them. The label is the first
    // four characters of the id, which is all a chip has room for.
    ...w.towns.all.map((t) => {
      const chip: CompassMarker = {
        id: `town:${t.id}`,
        x: t.gateX,
        z: t.gateZ,
        color: t.color,
        label: t.id.slice(0, 4).toUpperCase(),
      };
      _townChips.push({ chip, town: t });
      return chip;
    }),
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
/**
 * How near the hero something hostile has to be before his companions count as
 * NEEDED (see `supportNeeded`). 22 units: the support beast already casts at
 * `Math.max(skill.range, 12)` and an enemy walks that in a couple of seconds, so
 * this is "a fight is happening here" rather than "something is on the horizon".
 */
const SUPPORT_CALL_RANGE = 22;
/** Scratch list of live companions handed to combat each slice — never resized. */
const _friendlies: BeastActor[] = [];
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

// The bag holds everything with a COUNT — currency stays the running total
// above and beasts stay in the roster (see core/items.ts for why neither is in
// here). Combat reports every drop that leaves the ground; what to do with it is
// policy, so it is decided here.
const bag = new Inventory();

/**
 * The HUD's chip row is the STACKABLES only, and it is a narrower thing than the
 * bag now that the bag holds weapons and blueprints too.
 *
 * The row is not a summary of what you own — the inventory panel is that. It is
 * the readout for the support beast's fetch rule, and the invariant that makes
 * it worth having is "a chip is up exactly when the beast will fetch more of
 * that thing" (see `worthFetching`, which only ever runs an errand for a
 * stackable). Showing a greatsword there would break that and fill the top of
 * the screen with things the beast is never going to bring you.
 */
function refreshBagChips(): void {
  hud.setBag(bag.entriesOfKind('stackable'));
}

bus.on((e) => {
  if (e.type === 'shardsChanged') {
    pickupTotal = e.total;
    hud.setShards(shards());
  }
  if (e.type === 'itemPicked') {
    const def = itemDef(e.itemId);
    if (def.kind !== 'currency') {
      const n = bag.add(e.itemId, 1);
      refreshBagChips();
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
  // STACKABLE, not "anything you already hold". The rule was written when those
  // were the same set; issue #74 made them different, and a beast that fetched
  // the blueprint you just dropped — or the second potion out of a pair you are
  // holding — is running an errand nobody asked for. Every rare drop is now
  // something the player walked over themselves, which is also what makes the
  // 1-in-25 in `killEnemy` mean something.
  return def.kind === 'currency' || (def.kind === 'stackable' && bag.count(itemId) > 0);
}

// ---------------------------------------------------------------------------
// INVENTORY, GEAR AND THE THINGS YOU CAN DO TO A THING YOU OWN
//
// Issue #74. The PANEL (ui/inventory.ts) knows no game rules at all — it is
// handed rows with a list of actions and reports which button was pressed — so
// every rule is here, beside the state it governs. That is the same split
// ui/settings.ts draws and the same one this file already makes for the shop:
// the composition root owns policy that is no subsystem's own business.
//
// WHAT IS AND IS NOT STORED. The bag holds counts. The WEAPON slot is one id
// here, because it is a fact about the session rather than about any item. The
// two BEAST slots are `primaryIdx`/`supportIdx`, which already existed and which
// Tab and the beast-cycle keys already move — the panel drives those same two
// numbers rather than keeping a third, so equipping a beast from the panel and
// swapping with Tab can never disagree. The issue asks for exactly that ("these
// can be swapped when running around in the world without going into the
// inventory (that feature is already implemented)"), and the way to keep a
// feature working is to not build a second one beside it.
// ---------------------------------------------------------------------------

/**
 * The hero's own strength, before anything he is holding.
 *
 * Read off `Player` rather than written down, so the two cannot drift, and read
 * ONCE at boot because everything below writes `attackStat`. `Player.reset()`
 * deliberately does not touch that field — a stat is not session state from the
 * player controller's point of view — so `applyLoadout()` is what puts it back
 * on Exit to title.
 */
const BASE_ATTACK = player.attackStat;

/** The weapon in the gear slot, by item id, or null for bare hands. */
let equippedWeapon: string | null = null;
/** A potion's timed buff: how much attack it is adding, and for how much longer. */
let attackBuff = 0;
let attackBuffT = 0;

/**
 * Recompute everything a loadout decides. ONE function rather than an edit at
 * each of the five sites that can change the answer (equip, unequip, use, the
 * buff expiring, and the reset on Exit), because a derived value written in five
 * places is a derived value that is wrong in one of them.
 */
function applyLoadout(): void {
  const w = equippedWeapon ? itemDef(equippedWeapon) : null;
  player.attackStat = BASE_ATTACK + (w?.power ?? 0) + attackBuff;
  // ...and what he is HOLDING, which is the same decision seen from the other
  // side: `ItemDef.model` names a voxel model in player/weapons.ts, and null is
  // bare hands, which switches the animator to the punch table. The rig is the
  // storage, so there is no second field here to fall out of step with it.
  player.setWeapon(weaponModelOf(w));
  // The inventory's 3D stage holds its own hero rig and has to be told too. It
  // may be shut, in which case this is a field it will draw with next time.
  inventory.setHeroWeapon(w?.model ?? null);
}

/**
 * `ItemDef.model` narrowed to the union the rig understands, or null.
 *
 * The guard lives on this side because the field is a plain STRING: core/ may
 * not import player/ (see the note on `ItemDef.model`), so every reader checks
 * it. There is exactly one reader that matters and this is it.
 */
function weaponModelOf(def: ItemDef | null): WeaponModelId | null {
  const m = def?.model;
  return m && (WEAPON_MODEL_IDS as readonly string[]).includes(m)
    ? m as WeaponModelId
    : null;
}

/**
 * What a new game starts with.
 *
 * A starting kit rather than an empty bag, and the reason is not generosity: an
 * inventory whose every screen is empty until a 1-in-25 drop lands is a feature
 * nobody can see working, and the gear slot in particular has nothing to say
 * about itself while there is nothing to put in it. One weapon (equipped, so the
 * slot is filled and the stat it feeds is non-zero), a potion to drink and a
 * blueprint to look at is the smallest set that shows every kind of row the
 * panel can draw except the quest one — and that one is deliberately reachable
 * only through content (`item.give`) or the console.
 */
function giveStartingKit(): void {
  bag.add('sword-iron', 1);
  bag.add('potion-mend', 2);
  bag.add('bp-dagger', 1);
  equippedWeapon = 'sword-iron';
  applyLoadout();
  refreshBagChips();
}

/**
 * What `item.give` does once the parameters have been checked. A `function`
 * declaration rather than a const, so the registration three hundred lines above
 * can name it — see the note there.
 *
 * Currency is folded into the pickup total rather than refused, for the reason
 * `/give` gives: it is not a bag entry, and a handler that silently ignored
 * `{"item":"shard"}` would be the least useful possible answer.
 */
function giveItemFromContent(id: string, n: number): void {
  const def = itemDef(id);
  if (def.kind === 'currency') {
    pickupTotal += n;
    hud.setShards(shards());
  } else {
    bag.add(id, n);
    refreshBagChips();
  }
  bus.emit({ type: 'toast', text: t('toast.gotItem', { item: itemName(def, n) }) });
  // The panel is a modal so almost nothing can reach here while it is up — but
  // the dev console can, and so could a piece of content firing on a timer.
  inventory.refresh();
}

/** A beast's inventory id. The panel round-trips it; nothing else parses it. */
const beastItemId = (b: BeastActor): string => BEAST_ID_PREFIX + b.species.id;

/** One display stat pair, so the builders below all read the same way. */
const invStat = (label: StringKey, value: string | number): InvStat =>
  ({ label: t(label), value: String(value) });

/**
 * Build the rows the panel draws, from the bag and the roster.
 *
 * DERIVED EVERY TIME rather than kept — this runs on open and after each action,
 * which is a handful of times a session and never inside a frame — because the
 * two sources it reads are the truth and a cached view of them is a second
 * answer that can be stale.
 */
function inventoryModel(): InventoryModel {
  const entries: InvEntry[] = [];

  // Beasts first: they are the rows a player is most likely to have come for,
  // and this is the same roster order Tab cycles through.
  for (const b of roster) {
    const lead = b === primary();
    const supporting = b === support();
    entries.push({
      id: beastItemId(b),
      kind: 'beast',
      name: t(b.species.nameKey),
      count: 1,
      color: ELEMENT_COLORS[b.species.element],
      // The SPECIES, not a copy of anything off it. The panel's stage builds a
      // rig of its own from this and bakes the portrait the slot wears, which
      // is why a beast row shows the animal rather than a coloured lozenge —
      // see ui/inventory-stage.ts on why it may not borrow the roster's rig.
      species: b.species,
      rarity: 'rare',
      description: t(b.species.descriptionKey),
      equipped: lead || supporting,
      stats: [
        invStat('inv.stat.level', b.level),
        invStat('inv.stat.movement', t(LOCOMOTION_NAME_KEYS[b.species.locomotion])),
        {
          label: t('inv.gear'),
          value: t(lead ? 'inv.beast.lead' : supporting ? 'inv.beast.support' : 'inv.beast.benched'),
        },
      ],
      // A beast is never dropped or salvaged. Its two actions are the two slots
      // it can be moved into, and the one it is already in is not offered —
      // `cycleBeast` refuses to put one beast in both slots, and a button that
      // silently does nothing is worse than a button that is not there.
      actions: lead ? ['setSupport'] : supporting ? ['setLead'] : ['setLead', 'setSupport'],
    });
  }

  for (const e of bag.entries()) {
    const d = e.def;
    const stats: InvStat[] = [];
    if (d.power !== undefined) stats.push(invStat('inv.stat.power', '+' + d.power));
    if (d.maxPower !== undefined) stats.push(invStat('inv.stat.budget', d.maxPower));
    if (d.effect?.heal !== undefined) stats.push(invStat('inv.stat.heal', d.effect.heal));
    if (d.effect?.attack !== undefined) {
      stats.push(invStat('inv.stat.attack', '+' + d.effect.attack + ' · ' + (d.effect.seconds ?? 0) + 's'));
    }
    const worth = salvageValue(d);
    if (worth > 0) stats.push(invStat('inv.stat.salvage', worth));
    if (e.count > 1) stats.push(invStat('inv.stat.held', e.count));

    const actions: InvAction[] = [];
    const equipped = d.kind === 'weapon' && d.id === equippedWeapon;
    if (d.kind === 'weapon') actions.push(equipped ? 'unequip' : 'equip');
    if (d.kind === 'potion') actions.push('use');
    if (d.kind === 'blueprint') actions.push('forge');
    // An EQUIPPED weapon offers neither destructive action. Unequip is one click
    // away, and stating that order is better than a Drop that quietly takes the
    // sword out of the hero's hand and leaves the gear slot empty behind it.
    if (worth > 0 && !equipped) actions.push('salvage');
    if (isDestructible(d) && !equipped) actions.push('drop');

    entries.push({
      id: d.id,
      kind: d.kind,
      name: itemName(d, e.count),
      count: e.count,
      color: d.color,
      icon: d.icon,
      rarity: d.rarity,
      description: d.descriptionKey ? t(d.descriptionKey) : undefined,
      stats,
      equipped,
      note: d.kind === 'blueprint' ? t('inv.forge.soon')
        : d.kind === 'quest' ? t('inv.quest.kept')
        : undefined,
      actions,
    });
  }

  const byId = (id: string | null): InvEntry | null =>
    (id === null ? null : entries.find((x) => x.id === id) ?? null);

  return {
    gear: [
      { slot: 'weapon', entry: byId(equippedWeapon) },
      { slot: 'primary', entry: byId(beastItemId(primary())) },
      { slot: 'support', entry: byId(beastItemId(support())) },
    ],
    entries,
  };
}

/**
 * A button on a row. Every rule the panel does not know lives in this switch.
 *
 * It moves state and says something about it, and nothing else: the panel calls
 * `model()` straight afterwards, so there is no view to update from here.
 */
function inventoryAction(id: string, action: InvAction): void {
  if (id.startsWith(BEAST_ID_PREFIX)) {
    const speciesId = id.slice(BEAST_ID_PREFIX.length);
    const idx = roster.findIndex((b) => b.species.id === speciesId);
    if (idx < 0) return;
    // Straight onto the same two indices Tab moves, through the same
    // `refreshVisibility` — and the swap-out rule falls out for free: putting a
    // beast into one slot pushes whoever was there into the other rather than
    // benching them, which is what a player pressing Tab already expects.
    if (action === 'setLead') {
      if (supportIdx === idx) supportIdx = primaryIdx;
      primaryIdx = idx;
    } else if (action === 'setSupport') {
      if (primaryIdx === idx) primaryIdx = supportIdx;
      supportIdx = idx;
    } else {
      return;
    }
    refreshVisibility();
    bus.emit({
      type: 'toast',
      text: t('toast.beastLeads', {
        lead: t(primary().species.nameKey), support: t(support().species.nameKey),
      }),
    });
    return;
  }

  const def = itemDef(id);
  if (!isKnownItem(id) || bag.count(id) <= 0) return;

  switch (action) {
    case 'equip':
      if (def.kind !== 'weapon') return;
      equippedWeapon = def.id;
      applyLoadout();
      bus.emit({ type: 'toast', text: t('toast.equipped', { item: itemName(def) }) });
      break;

    case 'unequip':
      if (equippedWeapon !== def.id) return;
      equippedWeapon = null;
      applyLoadout();
      bus.emit({ type: 'toast', text: t('toast.unequipped', { item: itemName(def) }) });
      break;

    case 'use': {
      const fx = def.effect;
      if (!fx || bag.remove(def.id, 1) !== 1) return;
      if (fx.heal) player.heal(fx.heal);
      if (fx.attack) {
        // A second draught REPLACES the timer rather than stacking onto it. Two
        // buffs adding up is a balance decision and this is not the ticket that
        // makes it; refreshing is what a player expects from drinking the same
        // thing twice, and it cannot compound into a stat nobody has tuned.
        attackBuff = fx.attack;
        attackBuffT = fx.seconds ?? 0;
      }
      applyLoadout();
      refreshBagChips();
      bus.emit({ type: 'toast', text: t('toast.used', { item: itemName(def) }) });
      break;
    }

    case 'salvage': {
      const worth = salvageValue(def);
      // `remove` reports what actually LEFT, and the payout is off that number
      // rather than off the request — a stack that was already gone must not be
      // paid for. The proceeds go through `spent`, negatively: there is ONE
      // running total for the purse in this file (see `shards`), and adding a
      // second source of currency beside it is how the two stop agreeing.
      if (worth <= 0 || bag.remove(def.id, 1) !== 1) return;
      spent -= worth;
      hud.setShards(shards());
      refreshBagChips();
      bus.emit({
        type: 'toast',
        text: t('toast.salvaged', {
          item: itemName(def), n: worth, currency: itemName(CURRENCY, worth),
        }),
      });
      break;
    }

    case 'drop': {
      if (!isDestructible(def) || bag.remove(def.id, 1) !== 1) return;
      // UNARMED (see Pickups.spawn): it lands at the hero's feet, and armed it
      // would magnet straight back into the bag it just left.
      combat.spawnDrop(
        def.id, player.position.x, player.position.y + 0.6, player.position.z, false,
      );
      refreshBagChips();
      bus.emit({ type: 'toast', text: t('toast.dropped', { item: itemName(def) }) });
      break;
    }

    // The forge is issue #74's other half and is not built. The button is here
    // because a blueprint's own row is where a player will look for it, and the
    // note under it says what it is waiting for — a better answer than an item
    // with nothing to do at all.
    case 'forge':
      bus.emit({ type: 'toast', text: t('inv.forge.soon') });
      break;

    default:
      break;
  }
}

/**
 * Tick the potion buff. Called from a SIMULATION slice, so it runs on the same
 * clock the hero does and stops while a modal is up — a buff must not be
 * burning down behind the inventory screen the player drank it on.
 */
function updateBuffs(dt: number): void {
  if (attackBuffT <= 0) return;
  attackBuffT -= dt;
  if (attackBuffT > 0) return;
  attackBuffT = 0;
  attackBuff = 0;
  applyLoadout();
  bus.emit({ type: 'toast', text: t('toast.buffEnded') });
}

const inventory = new InventoryPanel({
  model: inventoryModel,
  onAction: inventoryAction,
  // Same bargain the shop and the in-game menu make, and for the same reason:
  // this is a panel you CLICK, so the cursor has to be able to reach it. The F1
  // sheet is the other case — read, not clicked — and keeps its lock.
  onOpen: () => input.releaseLock(),
  // TAKING THE POINTER BACK IS SAFE AFTER A CLICK OR AFTER `I`, AND IS NOT
  // AFTER ESCAPE — the pause menu's rule, and this panel needed it too. An
  // earlier version of this comment claimed the rule did not apply because the
  // panel is usually closed with `I`; it is closed with Escape just as often,
  // and that is the key the browser is spending. Where there is no keyboard
  // lock (Brave nulls `navigator.keyboard`) that same press is also leaving
  // fullscreen, which drops the pointer lock ~8 ms later — so a lock re-taken
  // here is one the browser knocks straight back out, and `Input.onLockLost`
  // reads the loss as a fresh Escape. The symptom is exactly what was reported:
  // one press closed the inventory and opened the in-game menu behind it.
  //
  // Nothing needs to be taken back after an Escape anyway: the next click does
  // it, as it always has. See `InvCloseBy`.
  onClose: (by) => {
    if (isTouchPrimary()) return;
    if (by !== 'escape' || escapeIsLocked()) input.requestLock();
  },
});

giveStartingKit();

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
  // THROUGH `Input`, NEVER STRAIGHT TO THE DOM. This was
  // `document.exitPointerLock()`, and the difference is not style: `releaseLock`
  // clears the INTENT first, and that intent is the whole of how
  // `Input.onLockLost` tells "the player pressed Escape and the browser took the
  // pointer" from "we gave it up on purpose". Released raw, the lock vanished
  // while `lockWanted` still stood, `onLockLost` tapped a virtual Escape, and
  // the very next simulation slice closed the den that had just opened — so on
  // any machine actually holding a lock, `E` at a skill den opened a shop that
  // shut itself before the player saw it.
  input.releaseLock();
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
  locomotion: p.species.locomotion,
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
touch = photoMode ? null : TouchControls.attach(input);

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
// ONE resolved answer for both stick devices, rather than the same two `??`
// chains written twice: the overlay is attached above (it has to exist before
// the first frame that might tick it) and is told the axes here, where the
// preferences are finally read.
const lookAxes: LookAxes = {
  invertX: flags.invertLookX ?? prefs.invertLookX,
  invertY: flags.invertLookY ?? prefs.invertLookY,
};
pad = photoMode ? null : GamepadControls.attach(input, { look: lookAxes });
touch?.setLookAxes(lookAxes);

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
/**
 * THE OPENING POSE, and everything needed to judge it in one read.
 *
 * `start` is what the world decided (World.playerStart); `player` is where the
 * hero actually is now, which is the same thing on frame one and drifts the
 * moment anybody presses a key. `greeter` is the character the pose was
 * composed against, so `beside` and `faceGap` can be checked without the probe
 * knowing a name or a seed's coordinates — the whole reason the derivation
 * takes the nearest resident rather than `npc:gain`.
 *
 * `camFromFace` is the assertion the shot exists for, in degrees: the angle
 * between where the camera SITS relative to the hero and the way the hero is
 * LOOKING. Near 0 means the lens is in front of his face, near 180 means it is
 * behind his shoulder, which is every other moment in the game. Read-only.
 */
(window as unknown as { __dbgStart: () => unknown }).__dbgStart = () => {
  const s = world.playerStart;
  const g = world.npcs?.all[0] ?? null;
  const deg = (r: number): number => {
    let d = r;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return +((d * 180) / Math.PI).toFixed(2);
  };
  return {
    start: {
      x: +s.position.x.toFixed(2), y: +s.position.y.toFixed(2), z: +s.position.z.toFixed(2),
      yaw: +s.yaw.toFixed(3),
    },
    player: {
      x: +player.position.x.toFixed(2), z: +player.position.z.toFixed(2),
      facing: +player.facing.toFixed(3),
    },
    greeter: g && {
      id: g.id, x: +g.x.toFixed(2), y: +g.y.toFixed(2), z: +g.z.toFixed(2),
      restYaw: +g.restYaw.toFixed(3),
    },
    /** Distance from the hero's start to the greeter, in world units. */
    beside: g ? +Math.hypot(s.position.x - g.x, s.position.z - g.z).toFixed(2) : null,
    /** How far the hero's facing differs from the greeter's, degrees. */
    faceGap: g ? deg(s.yaw - g.restYaw) : null,
    /**
     * Angle between the camera arm and the hero's facing, degrees. 0 = his face.
     *
     * Measured off the camera's REAL position, exactly as `__dbgCamYaw` is,
     * rather than read back off the field the pose wrote. The arm is smoothed
     * and terrain can push the lens up and in, so the field says what was asked
     * for and this says what the player is looking through.
     */
    camFromFace: deg(Math.atan2(
      engine.camera.position.x - player.position.x,
      engine.camera.position.z - player.position.z,
    ) - player.facing),
    /** How far the start is from the world's own reference point. */
    fromSpawn: +Math.hypot(
      s.position.x - world.spawnPoint.x, s.position.z - world.spawnPoint.z,
    ).toFixed(2),
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
  // The pointer-lock recovery, as two answers rather than one: `autoRelock` is
  // the host's permission (see frame()), `relockPending` is whether there is a
  // pointer to recover at all. A probe reading only the first would pass in
  // exactly the case the feature is dead — permission granted, nothing armed.
  autoRelock: input.autoRelock,
  relockPending: input.relockPending,
  touchOverlay: !!document.querySelector('.bs-touch'),
  // Which way the OVERLAY's look pad runs, which is a different object from the
  // pad's answer in `__dbgPad` and has to be readable on its own — a phone run
  // has no gamepad to ask. Null where there is no overlay at all.
  touchLookAxes: touch?.lookAxes ?? null,
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

// Fullscreen and the Escape key. `keyboardLock` is whether this browser CAN be
// asked for Escape, `escapeLocked` is whether it granted it — two answers,
// because they disagree in exactly the cases the feature is broken in (an
// iframe, plain http, a policy), and a probe reading only the first would pass
// through all of them. `survivesEscape` is the third: whether New Game will take
// fullscreen at all (issue #83), which on a phone is true with no lock in sight.
// Read-only; see ui/fullscreen.ts.
(window as unknown as { __dbgFullscreen: () => unknown }).__dbgFullscreen = () => ({
  supported: fullscreenSupported(),
  active: isFullscreen(),
  keyboardLock: keyboardLockSupported(),
  escapeLocked: escapeIsLocked(),
  survivesEscape: fullscreenSurvivesEscape(),
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

// The music: which scene it thinks it is in, which file is loaded, whether the
// element is playing, and what volume the envelope has it at right now. Read
// only. `output` is the number to watch a fade on — `volume` is the master and
// does not move during one. `blocked` true means the browser refused to play a
// page nobody has touched yet, which is a normal state and not a failure.
// See src/audio/music.ts, and tools/test-music.mjs for what it is asserted on.
(window as unknown as { __dbgMusic: () => unknown }).__dbgMusic = () => music.debugState();
// TEST HOOK, like `__dbgHurt`: move the playhead. The loop seam the fades exist
// for is 85 seconds into the shortest track, which is not a thing a probe can
// wait for — see `MusicDirector.seek`.
(window as unknown as { __dbgMusicSeek: (t: number) => void }).__dbgMusicSeek =
  (t: number) => music.seek(t);
// TEST HOOK, and the same argument `__dbgMusicSeek` makes one line up: the only
// other way to ask what an AREA plays is to walk to the gateway, stand out a
// preload and cross, which is a minute of driving to read one field — and it
// can only ever reach the two zones this build happens to ship. Naming a scene
// directly is how a probe asks the question the fallback exists to answer,
// which is what an area NOBODY scored plays.
(window as unknown as { __dbgMusicScene: (s: string | null) => void }).__dbgMusicScene =
  (s: string | null) => music.setScene(s);

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
  /** The ANIMAL's altitude — what the flight clamps act on. See `bodyY`. */
  bodyY: mount.isMounted ? +mount.bodyY.toFixed(2) : null,
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
/**
 * Where your companions actually are, and whether they are travelling as light.
 *
 * `dy` and `reach` are the pair issue #70 is about and neither says it alone: a
 * beast can be nine units from the hero horizontally and ninety below him, which
 * is precisely the case the old x/z-only leash could not see. `needed` is the
 * combat gate the beam's landing rule reads.
 */
(window as unknown as { __dbgCompanions: () => unknown }).__dbgCompanions = () => {
  const p = player.position;
  const one = (b: BeastActor, role: string) => ({
    role, id: b.species.id, transit: b.inTransit, dead: b.isDead,
    // The ridden beast is placed by the saddle and never runs follow steering,
    // so it is the one row in here light travel says nothing about.
    ridden: mount.beast === b,
    d: +Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(2),
    dy: +(p.y - b.position.y).toFixed(2),
    pos: { x: +b.position.x.toFixed(2), y: +b.position.y.toFixed(2), z: +b.position.z.toFixed(2) },
  });
  return {
    player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    ground: +world.getHeight(p.x, p.z).toFixed(2),
    needed: primary().supportNeeded,
    beasts: [one(primary(), 'primary'), one(support(), 'support')],
  };
};
// TEST HOOK, like __dbgDrop below: put the hero at an absolute column in the
// ACTIVE zone. The zone tools need to place him at an exact distance from a
// gateway and hold him there — "walk for 1.4 s and hope" cannot demonstrate
// that a 3.0-unit enter radius and a 5.0-unit exit radius behave differently,
// and the oscillation test needs to cross a boundary at a known rate.
//
// `y` is OPTIONAL and, when given, is taken literally rather than resolved
// against the height field — which is the only way to put the hero on a flying
// island. There is no column query that could work it out for him: a carrier's
// deck is deliberately invisible to anything that has not already attached to
// it (see `CarrierRide.support`, and `CarrierRegistry.ceilingAt` for the one
// exception and why it is not a surface). Landing him inside the ride volume is
// what attaches him, on the next slice, through exactly the path a player
// flying in on a galebird takes.
(window as unknown as { __dbgTp: (x: number, z: number, y?: number) => void }).__dbgTp = (x, z, y) => {
  // THE SADDLE FIRST, and it is not optional: while mounted the hero's position
  // is written from the mount's every slice (`seatHero`), so setting the fields
  // below and stopping there moved him for a fraction of a frame and then put
  // him back — a teleport that silently did nothing. See
  // `MountController.teleport`, which moves the pair of them and re-seats him.
  mount.teleport(x, z, y);
  player.position.x = x;
  player.position.z = z;
  player.position.y = y ?? Math.max(world.getHeight(x, z), world.waterLevel);
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
  const target = combat.bestMeleeTarget(
    _dbgStrike, _aimDir, SWORD_REACH, AIM_ASSIST_CONE_COS, player.position.y,
  );
  // Named `reachable` because `inReach` is the shared proximity rule imported at
  // the top of this file; the REPORTED field keeps the name tools already read.
  const reachable = combat.bestMeleeTarget(
    _dbgStrike, _aimDir, SWORD_REACH, -1, player.position.y,
  );
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
      // Feet to feet, the axis the selection is now gated on — a target the
      // probe can see at `distance` 1.5 and `rise` 6 is the bug in issue #78.
      rise: +(e.position.y - player.position.y).toFixed(2),
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
    up: MELEE_UP_REACH,
    down: MELEE_DOWN_REACH,
    target: describe(target),
    inReach: describe(reachable),
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
// TEST HOOK, like __dbgDrop above, and the only way `tools/test-textsize.mjs`
// can see MOST of the HUD at once. Half the panels the 16px floor applies to are
// transient — the interact pill, the dialogue, the mount ring, the riding badge,
// a toast, the level-up banner — and three of those are exactly what issue #17
// named. Driving the game to produce all six for one screenshot means finding an
// NPC, a den, a mount and a level-up in one run; this raises them directly, with
// the same calls and the same markup a player gets. It is deliberately a HOOK
// rather than the probe reaching into `hud`: the shop needs the real skill
// registry and the real prices, which live here.
(window as unknown as { __dbgStageHud: () => boolean }).__dbgStageHud = () => {
  hud.showHint(t('hint.npcTalk', { key: hud.interactPrompt, name: t('npc.gain.name') }));
  hud.showDialogue(
    t('npc.gain.name'), t('npc.gain.greeting'),
    t('npc.dialogue.close', { key: hud.interactPrompt }),
  );
  hud.setMountHold(0.42);
  hud.setMounted(t('beast.emberfox.name'), false);
  hud.setBag([{ def: itemDef('sunberry'), count: 3 }, { def: itemDef('glowpebble'), count: 12 }]);
  bus.emit({ type: 'beastLevelUp', beastId: 'emberfox', nameKey: 'beast.emberfox.name', level: 4 });
  bus.emit({ type: 'toast', text: t('toast.fetched', { beast: 'Emberfox', item: 'Sunberries', n: 3 }) });
  tryOpenShop();
  return true;
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
// The settings panel's Graphics tab may now reach it. See `gfxLive` at the top.
gfxLive = true;
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
 * WHEN THE MOUSE CURSOR IS SHOWING, and there are two quite different reasons.
 *
 * ALT IS A HOLD. Keep it down and the pointer is yours; let go and the game
 * takes it back. This started as a toggle on the reasoning that flipping
 * several F3 rows in a row would be easier — that was the wrong trade. A hold
 * has no state to get out of step with what the player believes, cannot strand
 * anyone with the pointer released and no idea why, and matches the muscle
 * memory every other engine's editor camera uses. Note it does mean Alt+click,
 * which some window managers claim for dragging windows.
 *
 * A MENU IS THE OTHER REASON, and it is not a special case so much as the
 * ordinary one: the title screen, the Escape menu, the shop and the controls
 * sheet are all things you CLICK, they have all already released the pointer,
 * and a player looking at buttons should see something to click them with. It
 * is gated on `lastSource` rather than on a latch — a pad player driving the
 * same menu with the stick gets no cursor, and touching the mouse brings it
 * back on the next event.
 *
 * Neither is a modal in the F3 sense: Alt leaves the hero taking input, because
 * the whole point is to change something while the world carries on working.
 */
let cursorFree = false;
/** Alt at the previous call, so this can tell a RELEASE from a menu closing. */
let altWasHeld = false;
function updateCursorMode(): void {
  const altHeld = input.down('AltLeft') || input.down('AltRight');
  const altJustReleased = altWasHeld && !altHeld;
  altWasHeld = altHeld;
  const menuUp = (startMenu?.isOpen ?? false) || pauseMenu.isOpen
    || hud.isShopOpen() || hud.isControlsOpen() || inventory.isOpen;
  // A controller player is not pointing at anything, and a phone has no pointer
  // to draw. `lastSource` is the STAMP, rewritten on every real input — the
  // per-frame question, not the latch. See the HUD note in AGENTS.md.
  const want = altHeld || (menuUp && input.lastSource === 'kbm');
  if (want === cursorFree) return;
  cursorFree = want;
  cursorDirector.setEnabled(want);
  if (altHeld) {
    input.releaseLock();
  } else if (altJustReleased && !menuUp && !isTouchPrimary()) {
    // ONLY AN ALT RELEASE, which is what the line above this always claimed and
    // what it did not do. `cursorFree` goes false for two different reasons —
    // Alt let go, and a menu closing — and this branch took the pointer back for
    // BOTH, one keyup ahead of the menu's own `onClose`. That is the second
    // caller behind the menu reopening itself: closing with Escape re-took a
    // lock here, the fullscreen exit from that same key released it 8 ms later,
    // and the loss read as a fresh Escape. A menu released the pointer on the
    // way in and is the only thing that may decide about it on the way out.
    input.requestLock();
  }
}

/**
 * EVENT-DRIVEN, because the title screen has no frame loop to poll from.
 *
 * `frame()` does not run until New Game (see the boot note at the top of this
 * file), so a cursor that only updated per frame would never appear on the
 * poster — which is one of the two places it is explicitly wanted. Every input
 * that can change the answer is a DOM event anyway: Alt up or down, the mouse
 * moving, a key deciding the player is on the keyboard again.
 */
for (const ev of ['keydown', 'keyup', 'mousemove', 'mousedown', 'pointerlockchange']) {
  (ev === 'pointerlockchange' ? document : window)
    .addEventListener(ev, () => updateCursorMode(), true);
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
  name: 'give',
  args: '<item id> [count]',
  help: 'Put items in the bag. No arguments lists the catalogue.',
  run: (args) => {
    const [id, raw] = args;
    // No argument lists what there is, which is what makes the ids discoverable
    // — the same shape `/gfx` and `/nature` use, and the same reason.
    if (!id) {
      return Object.values(ITEMS)
        .map((d) => `${d.id.padEnd(17)} ${d.kind}`)
        .join('\n');
    }
    if (!isKnownItem(id)) {
      return `no such item "${id}" — /give with no arguments lists them`;
    }
    const def = itemDef(id);
    if (def.kind === 'currency') {
      // Currency is not in the bag (see core/items.ts), so it is added to the
      // pickup total rather than refused: a console that answered "no" here
      // would be technically right and useless.
      pickupTotal += Math.max(1, Number(raw) || 1);
      hud.setShards(shards());
      return `${shards()} ${itemName(CURRENCY, shards())}`;
    }
    const n = bag.add(id, Math.max(1, Number(raw) || 1));
    refreshBagChips();
    return `${itemName(def, n)} x${n}`;
  },
});
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
// A CHANGED DENSITY REACHES THE GROUND YOU ARE STANDING ON, which is the whole
// point of tuning from the console rather than from the URL. The listener is
// wired here — the composition root — for the same reason `GfxSinks` is: the
// parameter table knows what a number means and nothing about a streamer.
// `world` is a `let` and is reassigned on a zone switch, so this always rebuilds
// whichever world is current.
nature.onChange(() => world.rebuildProps());
devConsole?.register({
  name: 'nature',
  args: '[<param> [<value>] | <area>.<param> [<value>|reset] | reset]',
  help: 'Read or set the world\'s nature densities. 1 is the baseline; an area '
    + 'multiplies it. No arguments lists everything.',
  run: (args) => {
    const [lhs, raw] = args;
    if (!lhs) {
      const snap = nature.snapshot();
      const rows = NATURE_PARAMS.map(
        (p) => `${p.id.padEnd(8)} ${snap.baseline[p.id].toFixed(2)}  ${p.help}`,
      );
      const areas = Object.entries(snap.areas)
        .map(([k, v]) => `${k.padEnd(16)} x${v.toFixed(2)}`);
      return [
        'baseline (1 = the designed world)',
        ...rows,
        areas.length ? `\nareas\n${areas.join('\n')}` : '\nno area overrides',
        '\n/nature grass 0.5   /nature forest.trees 2   /nature forest.trees reset',
      ].join('\n');
    }
    if (lhs === 'reset') {
      nature.reset();
      return 'nature reset — rebuilding the streamed chunks';
    }
    const dot = lhs.indexOf('.');
    const id = (dot < 0 ? lhs : lhs.slice(dot + 1)) as NatureParamId;
    if (!NATURE_PARAMS.some((p) => p.id === id)) {
      return `no such parameter "${id}" — ${NATURE_PARAMS.map((p) => p.id).join(', ')}`;
    }
    if (dot < 0) {
      if (raw === undefined) return `${id} ${nature.base(id).toFixed(2)}`;
      return `${id} ${nature.setBase(id, Number(raw)).toFixed(2)} — rebuilding`;
    }
    // An AREA is a biome id today (world/nature.ts). Unvalidated on purpose:
    // the set widens as the world grows named regions, and a typo shows up as
    // an override that changes nothing rather than as a refusal that hides one.
    const area = lhs.slice(0, dot) as NatureAreaId;
    if (raw === undefined) return `${area}.${id} x${nature.areaFactor(area, id).toFixed(2)}`;
    if (raw === 'reset') {
      nature.setArea(area, id, null);
      return `${area}.${id} back to the baseline — rebuilding`;
    }
    const v = nature.setArea(area, id, Number(raw));
    return `${area}.${id} x${v.toFixed(2)} = ${(nature.base(id) * v).toFixed(2)} — rebuilding`;
  },
});

/**
 * `/content` — read the content graph, and drive the lazy half of it by hand.
 *
 * THE LOAD AND RELEASE ARMS ARE THE POINT. Everything else here `__dbgContent()`
 * already reports; what a console can do that a probe cannot is TRY IT. Measured
 * by typing it: `/content` lists `core 14 assets [boot]`, `/content load
 * example-quest` fetches that package's own chunk and answers `loaded
 * "example-quest": 1 assets`, `/content` then shows it under a `[debug]` lease
 * with `quest 1`, and `/content release example-quest` takes the definitions
 * away again and `quest` is back to 0. That is the whole of the lazy design made
 * demonstrable in two lines, and a feature nobody can operate by hand is a
 * feature nobody believes.
 *
 * UNDER THE `debug` LEASE, never `boot`. A package a developer opened is held by
 * a named holder that lets go, so it cannot be mistaken for core content and
 * cannot be released out from under the world by a stray command (spec §12.4).
 *
 * `load` is async and the console is not, so the result is PRINTED WHEN IT
 * ARRIVES rather than returned — a fetch has to be allowed to take a moment, and
 * a command that blocked on one would freeze the frame it was typed in.
 */
devConsole?.register({
  name: 'content',
  args: '[load <pkg> | release <pkg> | check]',
  help: 'Inspect loaded content packages, load or release one, or print the '
    + 'validation diagnostics. No arguments lists what is loaded.',
  run: (args) => {
    const [verb, pkg] = args;
    if (!verb) {
      const packs = content.packages.map(
        (p) => `${p.id.padEnd(12)} ${String(p.assets.length).padStart(3)} assets  `
          + `[${p.leases.join(' ')}]  ${p.source}`,
      );
      const counts = ['town', 'npc', 'biome', 'enemy', 'quest']
        .map((ty) => `${ty.padEnd(6)} ${content.all(ty).length}`);
      const bad = [...content.diagnostics(), ...contentIssues()].filter(
        (d) => d.severity === 'error' || d.severity === 'fatal',
      ).length;
      return [
        packs.length ? `packages\n${packs.join('\n')}` : 'no packages loaded',
        `\nassets\n${counts.join('\n')}`,
        `\n${bad} error(s) — /content check`,
        '\n/content load <pkg>   /content release <pkg>',
      ].join('\n');
    }
    if (verb === 'check') {
      const all = [...content.diagnostics(), ...contentIssues()];
      if (all.length === 0) return 'no findings';
      return all.map(
        (d) => `${d.severity.padEnd(5)} ${d.code.padEnd(16)} `
          + `${d.assetId ?? '-'}${d.field ? ` .${d.field}` : ''}\n      ${d.message}`
          + (d.fix ? `\n      fix: ${d.fix}` : ''),
      ).join('\n');
    }
    if (verb === 'load' || verb === 'release') {
      if (!pkg) return `which package? /content ${verb} <pkg>`;
      if (verb === 'release') {
        content.release(pkg, 'debug');
        return `released "${pkg}" (debug lease) — ${content.packages.length} loaded`;
      }
      void content.load(pkg, 'debug').then((r) => {
        devConsole?.print(
          r.loaded
            ? `loaded "${r.pkg}": ${r.assets.length} assets, ${r.diagnostics.length} finding(s)`
            : `"${r.pkg}" was already loaded; added a debug lease`,
        );
        for (const d of r.diagnostics) devConsole?.print(`  ${d.severity} ${d.code} ${d.message}`);
      });
      return `loading "${pkg}"…`;
    }
    return `unknown — /content [load <pkg> | release <pkg> | check]`;
  },
});
/**
 * Put the hero on a named beast, or take him off — the body of `/mount`, and
 * the body of the `__dbgRide` test hook below.
 *
 * EXTRACTED SO THE TWO CANNOT DRIFT. A probe that wants to measure what riding
 * a swimmer does has to be able to pick the swimmer, and the only other way in
 * is to type `/mount finnick` into the dev console one keystroke at a time —
 * which is a key edge per character, i.e. the exact thing that makes a probe
 * SOLO-only and flaky (see the note on `content` in tools/probe.mjs).
 *
 * The console is a DEVELOPER surface: it stays in English and it answers in
 * SPECIES IDS, which is also what its own argument takes. A localised name here
 * would mean `/mount` printing something you cannot type back at it.
 */
function devRide(arg: string | undefined): string {
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
}
devConsole?.register({
  name: 'mount',
  args: '[off|<speciesId>]',
  help: 'Ride the primary beast without the 2s hold; /mount off dismounts.',
  run: (args) => devRide(args[0]),
});
// TEST HOOK, and the same argument `__dbgTp` makes: it DRIVES STATE, which is a
// probe's job. `/mount` is the player-facing door and this is the same room.
(window as unknown as { __dbgRide: (id?: string) => string }).__dbgRide =
  (id) => devRide(id);
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
/**
 * The dial half of the music row, in the same shape as `/haptics` and `/shake`
 * and writing the same key the panel does (`game.settings.gameplay.volume`).
 *
 * It is not redundant with the strip of chips in Settings: the panel offers six
 * steps because a player choosing a level wants a level, and this takes any
 * value in between — which is the one thing worth having while balancing a track
 * against a scene. `?vol=` pins a value for one load without writing it.
 */
devConsole?.register({
  name: 'volume',
  args: '[<0..1>]',
  help: 'Show or set music volume. Persists. 0 unloads the track entirely.',
  run: (args) => {
    if (args[0] === undefined) {
      const at = flags.volume ?? (flags.silentBoot ? 0 : loadPrefs().volume);
      const why = flags.volume !== null ? ' (pinned by URL)'
        : flags.silentBoot ? ' (muted: menu=0 / photo=1 — pass ?vol= to hear it)' : '';
      return `volume = ${at}${why}`;
    }
    const v = Number(args[0]);
    if (!Number.isFinite(v) || v < 0 || v > 1) return 'usage: 0..1';
    savePrefs({ volume: v });
    if (flags.volume !== null) return `saved volume = ${v}, but this load is pinned to ${flags.volume}`;
    // Live: this is the one preference whose effect is audible while you type.
    music.setVolume(v);
    return `volume = ${v}`;
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
  help: 'Show or set stick look inversion (pad and touch). Persists. Y is on by default.',
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
    // effect you can only judge with the stick in your hand — either stick.
    const a: Partial<LookAxes> = axis === 'x' ? { invertX: on } : { invertY: on };
    pad?.setLookAxes(a);
    touch?.setLookAxes(a);
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

  // World-owned effects, for the same reason: the sky island's waterfall hangs
  // 190 units up and 170 out, so no staged frame above ever drew it and its two
  // programs would link on the frame the hero first looks up at the island.
  world.warmUpEffects(() => engine.render());
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

/**
 * How close to a skill den's marker you have to be for its prompt, and how far
 * above or below it that still counts.
 *
 * 3.5 is unchanged and is the number NPC_TALK_RANGE was tuned against — a den is
 * a building you stand in front of. The RISE is issue #78's half: the test was a
 * true `distanceTo`, so it was already the only proximity check in the game that
 * could not be fooled from the air, but a sphere shortens the horizontal reach
 * on sloping ground for no reason anyone asked for. Same cylinder as everything
 * else now, and the height is NPC_TALK_RISE's 2.5 because it is the same
 * question about the same hero — a hop and a hovering mount are in, a climb is
 * out.
 */
const SHOP_RANGE = 3.5;
const SHOP_RISE = 2.5;
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
    // `inTransit` for the same reason as `isDead`: a beast travelling as light
    // has no feet on the ground to part the grass with, and its position is
    // pinned above the hero, where a `walk` report would blow a hole in the
    // meadow he is flying over.
    if (p0 !== ridden && !p0.isDead && !p0.inTransit) {
      world.disturb(-2, p0.position.x, p0.position.y, p0.position.z, p0.radius,
        p0.species.locomotion === 'flying' ? 'fly' : 'walk');
    }
    if (p1 !== ridden && p1 !== p0 && !p1.isDead && !p1.inTransit) {
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
    || inventory.isOpen || !!devConsole?.isOpen;
  nearShop = false;
  nearNpc = null;

  // THE MOVING PARTS OF THE WORLD MOVE FIRST, before anything standing on them
  // is updated. It is not inside `zones.update` below and that is the ordering
  // decision rather than an oversight: the world update runs at the END of a
  // slice, so a per-slice delta published there could only be spent by the
  // riders on the NEXT slice, and a hero standing still on a deck would lag it
  // by a slice's travel every time it changed speed. See CarrierRegistry.
  //
  // Above the `interactive` branch, so a staged capture and a photo-mode frame
  // get the same moving world a played one does.
  world.carriers.advance(dt);
  // Whose contact the particle system tests this slice, or null. It integrates
  // on EVERY slice either way — a modal overlay freezes the hero, not the leaves
  // already falling behind it — so only the contact test needs someone to test.
  let toucher: Player | null = null;

  // The camera stick is a rate control, so it must inject its look delta BEFORE
  // the player/camera update takes it this slice — ticking it later in the frame
  // meant endFrame() wiped the delta before the camera ever saw it. It is per
  // SLICE rather than per frame, unlike the pad's poll below, and that is right
  // either way round now: each slice injects its own SIM_DT of turn and takes
  // exactly that back out again.
  if (interactive && !modal) touch?.update(dt);

  // A FROZEN HERO IS STILL STANDING ON SOMETHING. Both branches that skip the
  // player controller — photo mode, and every modal in the game — still have to
  // move him with whatever is carrying him, or a player who opened the menu on
  // the flying island watches it slide out from under his feet and is left
  // standing in the sky. Being frozen means "takes no input and runs no
  // physics", not "detached from the world"; the beasts and the wild population
  // below this branch were never frozen and never had the problem.
  //
  // The mount answers for the pair of them when one is being ridden (it writes
  // the hero's position), and is a no-op otherwise — so exactly one of these
  // two moves him, which is the same split `Player.update` makes.
  if (!interactive || modal) {
    mount.carryFrozen(dt);
    if (!mount.isMounted) player.carry();
    // ...and the LENS follows him, which `player.update` would have done and is
    // not going to. Skipped in photo mode, which drives the camera itself and
    // must not have the follow rig fighting it. See `Player.followCamera`.
    if (interactive) player.followCamera(dt);
  }

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
    nearShop = world.shopPositions.some((s) => inReach(
      s.x, s.y, s.z,
      player.position.x, player.position.y, player.position.z,
      SHOP_RANGE, SHOP_RISE,
    ));

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
    // TWO KEYS NOW, AND THE SPLIT IS THE POINT (issue #83 follow-up). Escape
    // CANCELS — it backs out of a conversation and closes the topmost panel —
    // and F10 OPENS THE MENU. They used to be one key, and the browser owns half
    // of what Escape does: it leaves fullscreen and it drops pointer lock, over
    // the page's head, on the press the player meant for the game. A menu key
    // the browser cannot touch is the fix; Escape keeps the meaning every other
    // application on the machine gives it.
    //
    // Every device arrives here and not just the keyboard: the pad's Start and
    // the touch overlay's MENU button tap a virtual F10, its B face taps a
    // virtual Escape, and the HUD's menu button taps F10 as well — so each edge
    // is read in ONE place for every way of pressing it.
    //
    // `pressed`, not `takePress`, because this is a SIMULATION slice — see the
    // note on takePress in core/input.ts and the F1 read further down, which is
    // the other half of that rule.
    if (first && input.pressed('Escape') && npcField?.talking) npcField.endTalk();
    if (first && input.pressed('F10')) pauseMenu.open();
  } else if (first && (input.pressed('Escape') || input.pressed('F10') || input.pressed('KeyE'))) {
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
    //
    // F10 IS A CANCEL IN HERE, which is what makes it a TOGGLE: the key that
    // opened the menu closes it, the way Start does on a console and the way F1
    // already works for the controls sheet. It is folded into the same branch as
    // Escape rather than given one of its own, so "one press dismisses one
    // thing" stays true however the press arrived.
    const cancel = input.pressed('Escape') || input.pressed('F10');
    if (pauseMenu.isOpen) {
      if (cancel) pauseMenu.onEscape();
      else pauseMenu.activate();
    } else if (inventory.isOpen) {
      // Same shape as the menu above: cancel asks the panel to spend the press
      // and X (KeyE on the pad) confirms the focused control, which is what
      // makes the inventory workable from a controller with no other buttons.
      if (cancel) inventory.onEscape();
      else inventory.activate();
    } else if (hud.isControlsOpen()) hud.closeControls();
    else hud.closeShop();
  }

  // Contact particles. Sits between the `player` and `beasts` profiler markers, so
  // its cost is measured in the `beasts` slot — its own timing is on
  // `__dbgTouchFx().ms`, which is finer grained than a section anyway.
  touchFx.update(dt, toucher);

  // Cooldowns
  for (const [id, t] of cooldowns) cooldowns.set(id, Math.max(0, t - dt));
  // ...and the potion buff, on the same clock and for the same reason: both are
  // durations the player is watching, so both stop while a modal is up.
  updateBuffs(dt);

  // Beasts follow
  const owner = { position: player.position, velocity: player.velocity, isSwimming: player.isSwimming };
  if (flags.beasts) {
    // The ridden beast has already been placed and animated by mount.update();
    // running follow steering on top of that would fight the reins.
    const ridden = mount.beast;
    // Is a companion WANTED this slice — see BEAM_LAND_FIGHT in beasts/framework.
    // A beast travelling as light re-forms from three times as high while this
    // stands, which is the "flies next to ground and gets attacked" half of
    // issue #70. Asked once and given to both, because "there is something on
    // the hero" is a fact about the hero, not about either beast. The radius is
    // the wild leash's own aggro neighbourhood rather than a new number.
    const needed = combat.findNearestEnemy(player.position, SUPPORT_CALL_RANGE) !== null;
    primary().supportNeeded = needed;
    support().supportNeeded = needed;
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

  // The conversation. `resolveText` on the key form is `t()` with no
  // placeholders — one map lookup and no allocation — and the HUD compares each
  // field before writing it, so rendering this every slice costs nothing while a
  // talk is open. Resolved HERE rather than where the payload was built, which
  // is what keeps a talk that is already open following a live language switch.
  const talk = world.npcs?.talking ?? null;
  if (talk) hud.showDialogue(resolveText(talk.name), resolveText(talk.line), dialogueFoot);
  else hud.hideDialogue();

  // A companion in transit is not on the friendlies list: it is light, it has no
  // position an enemy could walk to, and a wolf that picked it as a target would
  // stand under the hero swiping at nothing until he landed. `_friendlies` is
  // reused rather than rebuilt so this stays allocation-free per slice.
  _friendlies.length = 0;
  if (!primary().inTransit) _friendlies.push(primary());
  if (!support().inTransit) _friendlies.push(support());
  combat.update(dt, player as unknown as Damageable, _friendlies as unknown as Damageable[]);
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
  const modal = hud.isShopOpen() || hud.isControlsOpen() || pauseMenu.isOpen
    || inventory.isOpen;
  // A modal does not turn the camera, and the controls sheet is the one that has
  // to say so out loud: it keeps pointer lock (see the F1 read below), so unlike
  // the shop it goes on collecting mouse delta that no slice will spend. See
  // Input.clearLook for what that costs if it is left to pile up.
  if (modal) input.clearLook();
  // MAY A POINTER THE BROWSER TOOK BE TAKEN BACK? Escape drops pointer lock on
  // every browser — the keyboard lock only covers a FULLSCREEN document — so a
  // player who closes a panel with it is left in the world with mouse look
  // dead. `Input.armRelock` puts it back when they start moving again, and this
  // is the host's half of that: not while anything is being clicked, and not
  // while Alt is deliberately holding the cursor out (see `updateCursorMode`).
  input.autoRelock = !modal && !input.down('AltLeft') && !input.down('AltRight');

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
  // A town that moves moves its own chip. Two writes each, no DOM. See
  // `_townChips`, and `World.towns` for why a registry position is live.
  for (let i = 0; i < _townChips.length; i++) {
    const c = _townChips[i];
    c.chip.x = c.town.gateX;
    c.chip.z = c.town.gateZ;
  }
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
  // `I` is the inventory, and it is read HERE beside F1 for the same reason:
  // it is not a gameplay action, so a frame that drained no simulation slice
  // must still answer it, and `takePress` is what stops one press toggling the
  // panel two or three times at 165 Hz (see core/input.ts).
  //
  // GATED ON THE OTHER MODALS rather than only on itself: with the pause menu
  // up, `I` would otherwise build a second panel underneath it. Its own open
  // state is the exception, because that press is how it closes.
  if (!photoMode && input.takePress('KeyI')
    && (inventory.isOpen || !(modal || devConsole?.isOpen))) {
    inventory.toggle();
  }
  if (input.takePress('F2')) debug.toggle();
  // F3 is the panel F2's numbers are FOR. Deliberately not gated on photo mode
  // and deliberately not a modal — see the note at the top of ui/perf-panel.ts:
  // the whole point is to watch a working frame get cheaper, and a frozen world
  // streams nothing and animates nothing.
  if (input.takePress('F3')) perfPanel.toggle();
  // Re-evaluated per frame as well as on input events: opening the shop or the
  // controls sheet changes the answer and neither is a DOM event this file sees.
  updateCursorMode();
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
  // delta wants half of that treatment and the opposite of the other half: it is
  // a quantity to integrate, so dropping it on a slice-less frame silently
  // scaled look sensitivity DOWN — but leaving it here for the whole slice loop
  // scaled it UP, once per slice, which is issue #37. The camera takes it on the
  // first slice that runs (Input.takeLook) and this is now only the backstop for
  // a frame that ran no camera update at all.
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
 * WHAT CONTENT IS LOADED, WHAT IT SAYS, AND WHAT IS WRONG WITH IT.
 *
 * Read-only like every other probe here, and structuredClone-safe by
 * construction: everything below is a string, a number or a plain array of them,
 * so `tools/q.mjs` can read it. It exists for `tools/` — a probe that wants to
 * know whether the world it is measuring was cut from the content it thinks it
 * was, and a run that wants to see a package's findings without opening a
 * console.
 *
 * FOUR QUESTIONS, and they are four because a content bug can be at any of four
 * depths. `packages` is what LOADED and who is holding it open — a lease list
 * rather than a count, so a leak reads as "`zone` still holds this three zones
 * later" (src/content/types.ts). `assets` is what came out of it, by type.
 * `diagnostics` is everything the load, the cross-asset pass and the engine's
 * own placers found, worst first — the content runtime's own findings and
 * core/content-bridge.ts's merged, because a town that is missing from the world
 * is one question however far down it failed. `resolved` is the answer to that
 * question from the OTHER end: the ids that actually reached the world. An id in
 * `assets` and not in `resolved` is a piece of content the engine refused, and
 * the reason is in `diagnostics`.
 *
 * `state` is the save payload — the player's facts, not the definitions. It is
 * what `Exit to title` clears and the definitions are what it keeps.
 */
(window as unknown as { __dbgContent: () => unknown }).__dbgContent = () => {
  const byType: Record<string, number> = {};
  for (const type of ['town', 'npc', 'biome', 'enemy', 'quest', 'music']) {
    byType[type] = content.all(type).length;
  }
  return {
    ok: contentBoot.ok,
    /**
     * What loading and validating the core package cost, milliseconds.
     *
     * Reported rather than asserted, and it is the number that decides the
     * question "does this deserve a progress chip of its own": measured on the
     * dev server at 1280x800 it is 2.4 / 2.5 / 2.3 ms against a `world` stage of
     * ~390 ms and a shader sweep of ~10 s, so it does not, and it lives inside
     * the world stage instead. It is also the number that caught the provider
     * being reached through a chunk fetch — 15.8 ms, all of it a round trip. See
     * the import of `BundledProvider` at the top of this file. Re-measure here if
     * the core package ever grows.
     */
    bootMs: +contentBootMs.toFixed(2),
    packages: content.packages.map((p) => ({
      id: p.id,
      version: p.version ?? null,
      source: p.source,
      assets: p.assets.length,
      requires: [...p.requires],
      leases: [...p.leases],
    })),
    assets: byType,
    diagnostics: [...content.diagnostics(), ...contentIssues()].map((d) => ({
      severity: d.severity,
      code: d.code,
      assetId: d.assetId ?? null,
      field: d.field ?? null,
      message: d.message,
    })),
    // What reached the WORLD, from the world's own objects rather than from the
    // registry — which is the only way this can disagree with `assets`, and
    // disagreeing is exactly what it is for.
    resolved: {
      towns: world.towns.all.map((tn) => tn.id),
      npcs: (world.npcs?.all ?? []).map((n) => n.id),
      enemies: enemySpecies().map((e) => e.id),
    },
    state: content.state.toJSON(),
  };
};

/**
 * What the cached static shadow map is doing — whether it is on at all, how big
 * the box is, and the number the whole feature is about: FRAMES PER REBUILD.
 * See core/shadow-cache.ts, and tools/test-shadowcache.mjs for the guard.
 */
(window as unknown as { __dbgShadows: () => unknown }).__dbgShadows =
  () => engine.shadowDebug();

/**
 * The world's nature densities, and a WRITER for them.
 *
 * The read half is the usual read-only probe: the baseline, the area overrides
 * and whether anything has been touched at all. The write half is a TEST HOOK
 * like `__dbgTp` — a probe cannot type at the developer console, and the whole
 * assertion worth making about this feature is a before/after of the same
 * chunks under two different densities. It rebuilds the streamed chunks through
 * the same listener `/nature` does, so a probe drives exactly the player-facing
 * path. See world/nature.ts and tools/test-nature.mjs.
 */
(window as unknown as { __dbgNature: () => unknown }).__dbgNature = () => {
  // THE CENSUS IS THE ASSERTION. A snapshot of the settings only proves the
  // table stored what it was given; what the feature claims is that the WORLD
  // changed, so the vertex counts of the two prop meshes are reported beside
  // it. Read off the scene rather than off the streamer, for the same reason
  // tools/test-gfx.mjs reads draw calls: it is the frame's own answer.
  let chunks = 0;
  let props = 0;
  let grass = 0;
  engine.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.name.startsWith('chunk:')) return;
    const n = m.geometry.getAttribute('position')?.count ?? 0;
    if (m.name === 'chunk:terrain') chunks++;
    else if (m.name === 'chunk:props') props += n;
    else if (m.name === 'chunk:grass') grass += n;
  });
  return { ...nature.snapshot(), census: { chunks, propVerts: props, grassVerts: grass } };
};
(window as unknown as {
  __dbgSetNature: (id: string, value: number, area?: string) => unknown;
}).__dbgSetNature = (id, value, area) => {
  if (!NATURE_PARAMS.some((p) => p.id === id)) return null;
  if (area === undefined) nature.setBase(id as NatureParamId, value);
  else nature.setArea(area as NatureAreaId, id as NatureParamId, value);
  return nature.snapshot();
};

/** A/B the cache inside one page load; see `Engine.setShadowCacheEnabled`. */
(window as unknown as { __dbgShadowCache: (on: boolean) => void }).__dbgShadowCache =
  (on) => engine.setShadowCacheEnabled(on);

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
      name: resolveText(world.npcs.talking.name),
      line: resolveText(world.npcs.talking.line),
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
/**
 * THE MOVING PARTS OF THE WORLD, and who is standing on them.
 *
 * Everything `tools/test-carrier.mjs` asserts on comes from here, and the shape
 * is chosen for what a probe cannot otherwise see: a carrier's pose is easy to
 * read off the scene and its ATTACHMENT is not — "the hero is at the same place
 * on the deck he was ten seconds ago" is the whole feature, and no screenshot
 * and no position alone can say it.
 *
 * `onDeck` is therefore the interesting field: the hero's position expressed in
 * the frame's OWN coordinates, which stays put while he stands still however far
 * the island has travelled, and moves only when he walks. `dyaw` is what the
 * turn publishes; `ceiling` is what the flight ceiling is allowed to reach over
 * this column, which is the number that decides whether the island is reachable
 * at all (see MountController's ceiling clamp).
 *
 * Read-only; allocates, so never called from the frame loop.
 */
(window as unknown as { __dbgCarriers: () => unknown }).__dbgCarriers = () => ({
  ceiling: (() => {
    const c = world.carriers.ceilingAt(player.position.x, player.position.z);
    return Number.isFinite(c) ? +c.toFixed(2) : null;
  })(),
  riding: world.carriers.at(player.position.x, player.position.y, player.position.z)?.id ?? null,
  all: world.carriers.all.map((c) => {
    // World -> the frame's own axes, the same map `CarrierBody.toLocal` uses.
    // Restated here rather than exposed on the contract because a debug hook is
    // the only caller that has ever wanted it from outside.
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    const wx = player.position.x - c.x;
    const wz = player.position.z - c.z;
    return {
      id: c.id,
      x: +c.x.toFixed(2),
      y: +c.y.toFixed(2),
      z: +c.z.toFixed(2),
      yaw: +c.yaw.toFixed(4),
      radius: +c.radius.toFixed(2),
      dyaw: +c.dyaw.toFixed(5),
      /** Units of translation published for the slice just simulated. */
      step: +Math.hypot(c.dx, c.dz).toFixed(4),
      deckTop: (() => {
        const t = c.topAt(player.position.x, player.position.z);
        return Number.isFinite(t) ? +t.toFixed(2) : null;
      })(),
      /**
       * The MASS in this column: the turf, and the keel under it — or null off
       * the footprint. `surface` is not `deckTop`, which is the top of whatever
       * is standing here; the pair a probe has to assert on is this one, because
       * it is the pair a body cannot be between (issue #80, tools/test-carrier).
       */
      surface: (() => {
        const d = c.deckAt(player.position.x, player.position.z);
        return Number.isFinite(d) ? +d.toFixed(2) : null;
      })(),
      keel: (() => {
        const b = c.bottomAt(player.position.x, player.position.z);
        return Number.isFinite(b) ? +b.toFixed(2) : null;
      })(),
      onDeck: {
        x: +(wx * cs - wz * sn).toFixed(3),
        y: +(player.position.y - c.y).toFixed(3),
        z: +(wx * sn + wz * cs).toFixed(3),
      },
    };
  }),
});

/**
 * THE CARRIED ISLAND'S WATERFALL. For tools/test-waterfall.mjs.
 *
 * Two things in one reading, because they are two halves of one change. The
 * `length` / `push` / `sprayAlive` / `frozen` counters are the effect's own; the
 * `meshOriginY` / `meshMinY` pair is the ROCK's, and it is there to prove the
 * island did not move when forty courses of voxel waterfall came out of it.
 * `meshOriginY` must equal `meshMinY * cell` (the rebase identity `buildRock`
 * documents) and `meshMinY` must still be the keel's own depth.
 *
 * Null in a world with no carried island — the hold, and the lab's stage.
 */
(window as unknown as { __dbgSkyFall: () => unknown }).__dbgSkyFall =
  () => world.debugSkyFall();

/**
 * THE WOOD ON A CARRIED DECK, AND WHETHER IT BLOCKS. For tools/test-carrier.mjs.
 *
 * Every tree the carried settlement planted, with the collision query's own
 * answer at its column — and a control sweep of the whole deck beside it,
 * because "there is something solid here" only means something next to "and not
 * everywhere". A carrier moves about a unit a second, so BOTH are read in one
 * evaluation: a probe that fetched the positions and then asked about them
 * would be asking about where the tree was.
 *
 * `rise` is measured off the deck plane (the frame's own origin), so it is the
 * height of the bole and not an altitude that changes as the island climbs.
 */
(window as unknown as { __dbgCarriedWood: () => unknown }).__dbgCarriedWood = () => {
  const c = world.carriers.all[0];
  if (!c) return { deck: null, trees: [], sampled: 0, raised: 0 };
  const trees = world.debugCarriedTrees().map((t) => ({
    x: +t.x.toFixed(2),
    z: +t.z.toFixed(2),
    rise: +(c.topAt(t.x, t.z) - c.y).toFixed(2),
  }));
  let sampled = 0;
  let raised = 0;
  const step = c.radius / 12;
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      const t = c.topAt(c.x + i * step, c.z + j * step);
      if (t === -Infinity) continue;
      sampled++;
      // A whole unit over the turf: above `MAX_STEP_UP` by a wide margin, so
      // this counts obstacles rather than the odd doorstep.
      if (t > c.y + 1) raised++;
    }
  }
  return { deck: +c.y.toFixed(2), trees, sampled, raised };
};

/**
 * THE INVENTORY, FOR tools/test-inventory.mjs.
 *
 * Everything a probe cannot see any other way. `attackStat` is the one that
 * makes the gear slot testable at all: a weapon icon in a slot looks identical
 * whether or not equipping it did anything, and this is the number that says.
 * `panel` reports what is actually on the DOM, so a model that is right and a
 * screen that is empty are distinguishable.
 */
(window as unknown as { __dbgInventory: () => unknown }).__dbgInventory = () => {
  const m = inventoryModel();
  return {
    open: inventory.isOpen,
    shards: shards(),
    attackStat: player.attackStat,
    baseAttack: BASE_ATTACK,
    buff: { attack: attackBuff, seconds: +attackBuffT.toFixed(2) },
    weapon: equippedWeapon,
    hp: +player.hp.toFixed(1),
    gear: m.gear.map((g) => ({ slot: g.slot, id: g.entry?.id ?? null })),
    bag: bag.entries().map((e) => ({ id: e.def.id, kind: e.def.kind, count: e.count })),
    entries: m.entries.map((e) => ({
      id: e.id, kind: e.kind, count: e.count,
      equipped: !!e.equipped, actions: e.actions ?? [],
    })),
    // What the DOM holds, or nulls when the panel is shut.
    //
    // `portraits` is the one worth explaining: a beast slot's picture is BAKED
    // by the panel's 3D stage a frame at a time (see ui/inventory-stage.ts), so
    // it is the count of beast slots that have stopped being a placeholder
    // lozenge — which is the only thing that can tell "the stage rendered ten
    // models" from "the stage never came up and every slot is a coloured blob".
    panel: inventory.isOpen ? {
      slots: document.querySelectorAll('.bs-inv .slot').length,
      // The wall is a FIXED 11x3 of real cells, so "how many rows does the
      // player own" and "how many boxes are drawn" are two different numbers
      // now and the probe needs both — see INV_COLS in ui/inventory.ts.
      filled: document.querySelectorAll('.bs-inv .slot:not(.empty)').length,
      gearSlots: document.querySelectorAll('.bs-inv .gs').length,
      tabs: document.querySelectorAll('.bs-inv .chip.tab').length,
      icons: document.querySelectorAll('.bs-inv .slot .ic:not(.blob)').length,
      portraits: document.querySelectorAll('.bs-inv .slot .ic.beast:not(.blob)').length,
      stageGl: !!document.querySelector('.bs-inv canvas.stage-gl'),
      // WHO IS ACTUALLY IN THE STAGE'S SCENE — not who was asked for. The two
      // disagreed when the beasts swapped slots, which is the bug: the second
      // slot's turn removed the rig the first slot had just placed. See
      // `InventoryStage.setCast`.
      stageCast: inventory.stageCast(),
      footActions: [...document.querySelectorAll('.bs-inv .sel button')]
        .map((b) => (b as HTMLElement).dataset.do ?? ''),
      tip: document.querySelector('.bs-inv .tip.on')?.textContent ?? null,
      selected: (document.querySelector('.bs-inv .slot.sel') as HTMLElement | null)
        ?.dataset.sel ?? null,
    } : null,
  };
};

/**
 * WHAT THE HERO IS HOLDING AND WHAT HE HAS FIRED.
 *
 * `weapon` is read off the RIG (see `Player.weapon`), which is the only copy —
 * so this cannot report a sword while a bow is drawn. `shots` is the live
 * projectile census, and the `arrow` flag on it is the whole of "the bow fires
 * an arrow": the pool is shared with every skill in the game, so a shot that
 * came out as a fireball would be indistinguishable from a working bow in any
 * other reading.
 */
(window as unknown as { __dbgShots: () => unknown }).__dbgShots = () => ({
  weapon: player.weapon,
  attackStat: player.attackStat,
  shots: combat.projectileSnapshot(),
});

/**
 * TEST HOOKS, the same class as `__dbgDrop` and `__dbgHurt`: stage a bag state
 * and press a button, without farming a 1-in-25 drop to get there or driving a
 * cursor onto a slot to press it.
 *
 * `__dbgInvAction` deliberately goes through `inventoryAction` rather than
 * through the panel, which is what makes the quest-item control in
 * tools/test-inventory.mjs mean anything: the refusal has to live in the
 * handler, not only in which buttons the panel chose to draw.
 */
(window as unknown as { __dbgGive: (id: string, n?: number) => void })
  .__dbgGive = (id, n = 1) => { if (isKnownItem(id)) giveItemFromContent(id, n); };

/** Drive one inventory button without a click, for the probe. */
(window as unknown as { __dbgInvAction: (id: string, action: string) => void })
  .__dbgInvAction = (id, action) => {
    inventoryAction(id, action as InvAction);
    // The panel re-reads after a button it pressed itself; this hook goes
    // straight to the handler, so it owes the screen the same refresh — without
    // it a probe reads a panel one action behind the state it is asserting on,
    // which is a failure in the test and not in the game.
    inventory.refresh();
  };

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
    // BANDED IN HEIGHT, for the reason `__dbgStructures` states at length: a
    // carried settlement flying over a ground one lands inside its radius and
    // is counted as its colliders. `y` is the town's own level, so a CARRIED
    // town bands around its own deck and gets its own boxes rather than the
    // ground's.
    const within = (x: number, y: number, z: number, r: number): number => {
      let n = 0;
      for (let i = 0; i < b.length; i += 6) {
        if (Math.abs(b[i + 5] - y) > 60) continue;
        if (Math.hypot(b[i] - x, b[i + 1] - z) <= r) n++;
      }
      return n;
    };
    return {
      boxes: b.length / 6,
      perTown: world.towns.all.map((town) => ({
        id: town.id,
        boxes: within(town.x, town.y, town.z, town.radius + 4),
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
    // Whether something is carrying it — see TownInfo.carried. A probe that
    // reasons about the ground a settlement stands on has to be able to tell,
    // because a carried town's colliders are in its carrier's frame and its
    // position is a reading rather than a placement.
    carried: town.carried,
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

/**
 * Where the skill dens are, and which way each faces.
 *
 * The dens are the one class of building that is not in the town registry, so
 * `__dbgTowns` cannot find them and a probe aiming at one had nothing to aim
 * with — which is the same reason `__dbgStructures` exists rather than tests
 * pinning a seed's coordinates. `facing` is the bearing of the OPEN front (the
 * counter, between the banners): a den is turned to look at the spawn, so this
 * is where a player walks up from. Read-only, allocates.
 */
(window as unknown as {
  __dbgShops: () => Array<Record<string, number>>;
}).__dbgShops = () => world.shopPositions.map((p) => ({
  x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
  facing: +Math.atan2(world.spawnPoint.x - p.x, world.spawnPoint.z - p.z).toFixed(3),
  distToSpawn: +p.distanceTo(world.spawnPoint).toFixed(2),
}));

/**
 * Every disc the wild population may not appear in, and who claimed it.
 *
 * The failure mode of a keep-out is INVISIBLE — a monster that did not spawn
 * leaves nothing behind — so the only way to tell "the zones are working" from
 * "the spawner is broken" is to read the discs and then ask `blocks` about a
 * point. Both are here, which is why this takes an optional column: with no
 * arguments it is the census, with (x, z) it is the same question `trySpawn`
 * asks. Read-only, allocates; the world's own answer, not a recomputation of it.
 */
(window as unknown as {
  __dbgSafeZones: (x?: number, z?: number) => unknown;
}).__dbgSafeZones = (x, z) => ({
  zones: world.safeZones.all.map((s) => ({
    id: s.id, x: +s.x.toFixed(2), z: +s.z.toFixed(2), radius: +s.radius.toFixed(2),
  })),
  towns: world.towns.all.map((t) => ({
    id: t.id, radius: t.radius, outerRadius: +t.outerRadius.toFixed(2),
    noSpawnRadius: +t.noSpawnRadius.toFixed(2),
  })),
  blocks: x === undefined || z === undefined ? null : world.safeZones.blocksSpawn(x, z),
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
  // The two WET queries, added with the deep sea (issue #76). They belong
  // beside the four above for the same reason those four are separate: each is
  // a different question a mover asks about the same column, and a probe that
  // had to derive "is this deep" from `ground` would be hard-coding a threshold
  // the world owns (see DEEP_WATER_DEPTH in world/terrain.ts).
  water: world.isWater(x, z),
  deep: world.isDeepWater(x, z),
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
// EVERY LAYER, and this is not optional since core/shadow-cache.ts moved the
// world's static geometry onto a layer of its own. A Raycaster starts on layer
// 0 alone, so a default one now fires straight through the terrain, the trees
// and the towns and reports whatever glow sprite it meets on the way — i.e.
// exactly the surface question this exists to answer, answered about nothing.
_surfRay.layers.enableAll();
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
  // A COLUMN, NOT A DISC. This asked a purely horizontal question, which was
  // exact for as long as everything built in the world stood on the ground —
  // and stopped being exact the day a settlement started flying over it. With
  // the island overhead, its two hundred-odd boxes fall inside the radius of
  // whatever ground town it happens to be above and are reported as that
  // town's: measured, the Encampment came back with 73 colliders against its
  // budget of 64, and nothing had been built in it.
  //
  // So the query is banded. `CEILING` is generous — a tower is 24 units and a
  // roof ridge a few more — and the island cruises at 190, so there is no
  // ambiguity to resolve, only a line to draw.
  const CEILING = 60;
  const ground = world.getHeight(x, z);
  for (let i = 0; i < b.length; i += 6) {
    const d = Math.hypot(b[i] - x, b[i + 1] - z);
    if (d > r) continue;
    if (b[i + 5] > ground + CEILING) continue;
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
