import * as THREE from "three";
import { Engine } from "./core/engine";
import { DayNightCycle } from "./core/day-night";
import { DebugOverlay } from "./core/debug-overlay";
import { Gfx, GFX_OPTIONS, storedGfx, type GfxSinks, type GfxValue } from "./core/gfx";
import { PerfPanel, type AppearanceControl, type PathEditControl } from "./ui/perf-panel";
import {
  HAIR_STYLES,
  HAIR_SWATCHES,
  storeHairColour,
  storeHairStyle,
  storedHairColour,
} from "./player/hair";
import type { SpawnCatalogue } from "./core/spawn";
import { Cursors, CursorDirector, CURSOR_STATES, type CursorState } from "./ui/cursor";
import { Input } from "./core/input";
import { TouchControls, isTouchPrimary } from "./core/touch";
import { installViewport } from "./core/viewport";
import { GamepadControls, type LookAxes } from "./core/gamepad";
import { FeedbackSystem } from "./feedback";
import { loadPrefs, savePrefs } from "./core/prefs";
import {
  deleteSave,
  listSaves,
  readSave,
  savesAvailable,
  writeSave,
  type SaveDocument,
  type SaveMeta,
} from "./core/saves";
import {
  EventBus,
  ELEMENT_COLORS,
  inReach,
  LOCOMOTION_NAME_KEYS,
  MOUNT_KINDS,
  MOUNT_KIND_KEYS,
  MOUNT_KIND_OF,
  type BeastSpecies,
  type CrownContact,
  type NpcInfo,
  type SkillDef,
  type Damageable,
  type ItemDef,
  type MountKind,
  type World,
  type WorldBound,
} from "./core/types";
import {
  Inventory,
  SlotLayout,
  itemDef,
  itemName,
  isKnownItem,
  isDestructible,
  salvageValue,
  ITEMS,
  ORB_IDS,
  CURRENCY,
  BEAST_ID_PREFIX,
} from "./core/items";
import { WEAPON_MODEL_IDS, type WeaponModelId } from "./player/weapons";
import { t, onLanguageChange, type StringKey } from "./i18n";
import { perf } from "./core/profiler";
import { flags } from "./core/flags";
import { DevConsole } from "./ui/console";
import {
  bootstrapContent,
  content,
  factory,
  hasText,
  resolveText,
  MUSIC_TRACK_KIND,
  type BiomeData,
  type MusicData,
  type ObjectiveTrigger,
  type ObjectiveTriggerKind,
  type QuestData,
  type QuestRewards,
} from "./content";
import { isId } from "./content/ids";
import type { ContentAsset, ContentId } from "./content/types";
// Only the Vite entries may link a content provider: src/content/ must not statically reach
// storage/bundled.ts (import.meta.glob breaks test-zfight under Bun), and this keeps boot off a fetch.
import { BundledProvider } from "./content/storage/bundled";
import { contentIssues, reportContentIssue } from "./core/content-bridge";
import { ColliderView } from "./core/collider-view";
import { createWorld, type LandmarkProbe } from "./world/index";
import { SEA_DIR, SEA_FULL } from "./world/terrain";
import { NPC_TALK_RANGE } from "./world/npc";
import { QuestMarkers, type QuestMarkerKind, type QuestMarkerSpot } from "./world/quest-markers";
import { TRAIL_PROFILE } from "./world/path-profile";
import {
  FENCE_POST_H,
  FENCE_POST_R,
  FENCE_POST_WIDTH,
  FENCE_RAIL_AT,
  FENCE_RAIL_HEIGHT,
  FENCE_RAIL_WIDTH,
} from "./world/town-parts";
import { nature, NATURE_PARAMS, type NatureAreaId, type NatureParamId } from "./world/nature";
import { createDungeon, holdFloorSpot } from "./world/dungeon";
import { Ferry, type FerryStop } from "./world/ferry";
import { SURFACE_Y } from "./world/water";
import { ZoneManager, type ZoneDef } from "./world/zones";
import { Underwater } from "./world/underwater";
import { TouchParticles } from "./world/touch-particles";
import { Player } from "./player/index";
import { MountController, MountUnlocks } from "./player/mount";
import { BeastActor, registerSkillDefs } from "./beasts/framework";
import { CombatSystem, SWORD_REACH } from "./combat/index";
import {
  enemySpecies,
  spawnTableReport,
  MELEE_UP_REACH,
  MELEE_DOWN_REACH,
  type Enemy,
  type EnemySpec,
} from "./combat/enemies";
import {
  HUD,
  kbd,
  type BeastHudInfo,
  type CompassMarker,
  type QuestTrackRow,
  type ShopOffer,
  type SkillSlot,
} from "./ui/index";
import { StartMenu } from "./ui/menu";
import { PauseMenu } from "./ui/pause";
import {
  InventoryPanel,
  type InvAction,
  type InvEntry,
  type InvStat,
  type InventoryModel,
  type GearSlotView,
} from "./ui/inventory";
import {
  JournalPanel,
  type JournalEntry,
  type JournalHover,
  type JournalModel,
  type JournalTab,
} from "./ui/journal";
import { entryIconHtml, type TipContent } from "./ui/tooltip";
import { FLAG_ICON, QUEST_STAR_ICON } from "./ui/icons";
import { MapPanel, type MapTerrain } from "./ui/map";
import { Exploration } from "./world/exploration";
import {
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  installEscapeLock,
  keyboardLockSupported,
  escapeIsLocked,
  fullscreenSurvivesEscape,
} from "./ui/fullscreen";
import { LoadingScreen } from "./ui/loading";
import { MusicDirector, MUSIC_TRACKS } from "./audio/music";
import { ALL_SPECIES, SKILLS, getSkill } from "./beasts/registry";

const app = document.getElementById("app")!;
// Before the engine: #app and the renderer take their first size from this.
installViewport();
// Arms the keyboard lock that keeps Escape ours while fullscreen.
installEscapeLock();
const engine = new Engine(app);
const dayNight = new DayNightCycle();
const input = new Input(engine.renderer.domElement);
const bus = new EventBus();

// BOOT ORDER: the poster goes up first, then world/actors/shaders/streaming in phases with real
// paints between, and frame() only starts from beginPlay(). The menu is LIVE during the build.

let pad: GamepadControls | null = null;
let touch: TouchControls | null = null;
let feedback: FeedbackSystem | null = null;

// Guards reads of `gfx` (a const far below) while it is still in its dead zone.
let gfxLive = false;

/** True once every boot phase has finished; nothing may start playing before. */
let prepDone = false;
/** True once the title screen has handed over (or there was never one). */
let handedOver = false;
/** True once `frame()` is running. */
let playing = false;

// One settings object for both screens — there is one settings list (ui/settings.ts).
const settingsHooks = {
  // One switch moves both stick devices; the mouse is deliberately not here.
  onLookAxes: (a: Partial<LookAxes>) => {
    pad?.setLookAxes(a);
    touch?.setLookAxes(a);
  },
  onHapticFeedback: (on: boolean) => feedback?.setOptions({ hapticFeedback: on }),
  // No null guard: music is built before the menu.
  onVolume: (v: number) => music.setVolume(v),
  // Apply half only (the panel stored it); guarded, the sinks need engine and world.
  onGraphics: (id: keyof GfxSinks, value: GfxValue) => {
    if (gfxLive) {
      gfx.set(id, value);
    }
  },
  // Live re-arm; the elapsed clock is NOT reset with it.
  onAutosaveInterval: (minutes: number) => {
    autosaveMinutes = minutes;
  },
};

// Declared this early because the title screen lists characters during module evaluation, and a list read must queue behind an in-flight write.
let lastWrite: Promise<unknown> = Promise.resolve();

// Issue #171. Spread into BOTH StartMenu.offer calls so a hook cannot be added to one only.
const saveMenuHooks = {
  // After the write in flight — see `lastWrite`.
  listSaves: async (): Promise<SaveMeta[]> => {
    await lastWrite;
    return listSaves();
  },
  onDeleteSave: (id: number) => deleteSave(id),
  onLoad: async (id: number): Promise<boolean> => {
    const doc = await readSave(id);
    if (!doc) {
      return false;
    }
    pendingSave = doc;
    setActiveSave(id);
    return true;
  },
  // Same handshake as New Game: sets handedOver and waits on prepDone.
  onBegin: () => {
    handedOver = true;
    beginPlay();
  },
};

// Built before the title screen because the splash track is the title screen's.
const music = new MusicDirector(
  flags.volume ?? (flags.silentBoot ? 0 : loadPrefs().volume),
  (scene) => musicPlaylist(scene),
);

function musicPlaylist(scene: string): readonly string[] {
  if (scene === "title") {
    return [MUSIC_TRACKS.title];
  }
  // The area's playlist, else the one asset volunteering as fallback.
  const asset =
    content.get<MusicData>(`music:${scene}`) ??
    content.all<MusicData>("music").find((m) => m.data.fallback);
  if (asset === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const name of asset.data.tracks) {
    const url = factory<string>(MUSIC_TRACK_KIND, name);
    if (url !== undefined) {
      out.push(url);
    }
  }
  return out;
}

// Reassignable: Exit raises a NEW poster, the old one takes itself off the DOM.
let startMenu = StartMenu.offer({
  ...settingsHooks,
  // The poster's own fade is the transition into the loading screen behind it.
  onLeave: () => loading?.cover(),
  onStart: (name) => {
    playerName = name;
    handedOver = true;
    beginPlay();
  },
  ...saveMenuHooks,
});

const staged = startMenu !== null && !flags.photo;
const loading = staged ? new LoadingScreen() : null;
if (!staged) {
  handedOver = true;
}

// Splash track from the frame the poster goes up; unstaged paths go straight to play.
if (startMenu) {
  music.setScene("title");
}

// Start the game once everything is built AND the player has asked; two callers, last one wins.
const STARTER_BEAST = "frostwing";

function beginPlay(): void {
  if (playing || !prepDone || !handedOver) {
    return;
  }
  playing = true;
  // A LOAD REPLACES THE NEW GAME.
  if (pendingSave) {
    const doc = pendingSave;
    pendingSave = null;
    applySave(doc);
  } else {
    // No-op when already bonded, so this is safe after an exit to title too.
    grantBeast(STARTER_BEAST);
  }
  // Drain keys latched while the title screen was up — endFrame() only runs inside frame(), so the first slice would otherwise see the whole menu session at once.
  input.endFrame();
  loading?.finish();
  // New Game is also the gesture that makes audio legal at all: a title track the autoplay policy refused is dropped rather than faded.
  music.setScene("overworld");
  // Pushes the STORED gfx values (fps cap among them), not the URL/default cap.
  gfx.applyAll();
  if (staged) {
    // New Game is a click on a BUTTON, so the canvas sees no mousedown and mouse look would stay dead. Best-effort: needs a recent user activation.
    if (!isTouchPrimary()) {
      input.requestLock();
    }
    // Deferred: the first moment the player is looking at the game, not a poster.
    bus.emit({
      type: "toast",
      // A touchscreen laptop driven by mouse gets the desktop hint.
      text: t(isTouchPrimary() ? "toast.welcome.touch" : "toast.welcome.desktop"),
    });
  }
  frame();
}

// The action wheel: F10, the HUD button, pad Start, touch MENU. open() builds the DOM.
const pauseMenu = new PauseMenu({
  ...settingsHooks,
  // This wheel is CLICKED, not read: the cursor has to be able to reach every sector.
  onOpen: () => input.releaseLock(),
  // After a key only when Escape is ours: otherwise leaving fullscreen drops the lock 8 ms later, which reads as a fresh Escape.
  onClose: (by) => {
    if (isTouchPrimary()) {
      return;
    }
    if (by === "click" || escapeIsLocked()) {
      input.requestLock();
    }
  },
  onAction: (action) => {
    switch (action) {
      case "inventory":
        inventory.open();
        break;
      case "journal":
        journal.open();
        break;
      case "map":
        map.open();
        break;
      case "controls":
        input.releaseLock();
        hud.toggleControls();
        break;
      case "exit":
        exitToTitle();
        break;
    }
  },
});

// End the session and put the title screen back, in the same page. Everything that is a PLAY SESSION
// is thrown away, each by the object that owns it; the engine, world and rigs are KEPT, because
// rebuilding costs ~600 ms of world and ~13.5 s of shader relink. THIS LIST IS THE SAVE'S CHECKLIST.
function exitToTitle(): void {
  if (!playing) {
    return;
  }
  // Write the character down FIRST (issue #171); `collectSave` is sync, so the snapshot predates the resets. Ahead of `playing = false`, which `saveNow` refuses on.
  void saveNow();
  // Stops the loop at the top of frame(); nothing is torn down mid-draw.
  playing = false;
  // Fullscreen was TAKEN on New Game (ui/menu.ts); no browser undoes it on its own.
  exitFullscreen();
  input.releaseLock();
  // Back to the splash track; the zone's is faded and UNLOADED, not left decoding.
  music.setScene("title");

  // Overworld first: the reset below places the hero at `world.spawnPoint`, and the switch rebinds every `bound` subsystem against the right heightfield.
  if (zones.id !== "overworld") {
    zones.switchTo("overworld");
  }

  player.reset();
  mount.dismount();
  // A sail in flight dies with the session; the fade must not outlive it.
  sail = null;
  sailFade.style.display = "none";
  sailFade.style.opacity = "0";
  // Mount unlocks are story state; `collectSave` above already wrote them down.
  seedMountUnlocks();
  combat.reset();
  // F3-spawned props are session state. After the zone switch, to clear the overworld's.
  world.debugSpawn?.clear();
  // The facts, not the definitions.
  content.state.reset();
  dayNight.reset();
  for (const b of roster) {
    b.reset();
  }
  // Who you had bonded is session state: a new game starts with nobody.
  owned.clear();
  primaryIdx = -1;
  supportIdx = -1;
  devSeated = 0;
  refreshVisibility();
  cooldowns.clear();
  spent = 0;
  bag.clear();
  // Where things sat on the wall goes with what was on it.
  slots.clear();
  // The readied orb is a pointer into the bag that was just emptied.
  readiedOrb = null;
  refreshOrbHud();
  inventory.close();
  journal.close();
  map.close();
  // The flag is the character's, and the chip goes with it.
  setPlayerMarker(null);
  exploration.reset();
  // `attackStat` is the one loadout field Player.reset deliberately leaves alone (see BASE_ATTACK); giveStartingKit re-equips and calls applyLoadout.
  equippedWeapon = null;
  attackBuff = 0;
  attackBuffT = 0;
  giveStartingKit();
  fetchScanT = 0;
  nearShop = false;
  nearNpc = null;
  world.npcs?.endTalk();
  // An escort in flight is SESSION state, deliberately not saved (issue #234): the
  // walk restarts from the giver's still-open dialogue row, so the save owes only
  // the objective's progress, which ContentState already carries.
  world.npcs?.cancelEscorts();
  hud.closeShop();
  hud.closeControls();
  hud.reset();
  touch?.setVisible(true);
  // Left true, the title screen would grab the pointer back off the New Game button.
  input.autoRelock = false;
  // Session state too (issue #171): left set, the next New Game would autosave over it.
  setActiveSave(null);
  playerName = "";
  pendingSave = null;
  carriedExtra = undefined;
  sinceSave = 0;
  questSaveIn = 0;
  // Which town the hero is standing in is DERIVED, not progress: what it fires on is an EDGE, and a
  // stale one would swallow the next character's first arrival. The discoveries themselves live in
  // `ContentState`, which was just reset, so there is nothing here for a save to carry.
  inTown = null;

  // A NEW instance: the old poster left the DOM when the game started.
  handedOver = false;
  startMenu = StartMenu.offer(
    {
      ...settingsHooks,
      onLeave: () => loading?.cover(),
      onStart: (name) => {
        playerName = name;
        handedOver = true;
        beginPlay();
      },
      ...saveMenuHooks,
    },
    { skipSplash: true },
  );
  // Exit cannot be reached under menu=0/photo; the guard keeps that from being a black screen.
  if (!startMenu) {
    handedOver = true;
    beginPlay();
  }
}

// SAVING AND LOADING A CHARACTER — issue #171, the inverse of `exitToTitle`.

// The character being played, or null for a session that is not saved (probe, first write pending).
let activeSaveId: number | null = null;
// Bumped on every change of character: a write OUTLIVES the session that asked for it, so it must not name a save it is no longer writing.
let saveEpoch = 0;

// Every change of IDENTITY goes through here, or `saveNow`'s guard has nothing to compare against.
function setActiveSave(id: number | null): void {
  activeSaveId = id;
  saveEpoch++;
}
/** What the player typed on New Game. Display only — the id is the key. */
let playerName = "";
// Read at CLICK time, so `beginPlay` stays synchronous and its handshake is unchanged.
let pendingSave: SaveDocument | null = null;
// Fields written by a NEWER build, carried from the load to the next write of the same character, so a downgrade's first autosave does not delete them.
let carriedExtra: Record<string, unknown> | undefined;
// True while `applySave` runs: restoring the facts fires the same notifications a quest completing does, which would autosave back what was just read.
let applyingSave = false;

// How far below the waterline still counts as standable ground: 1.5 is waist-deep on a 1.8 hero — a wade he can walk out of, not a resume treading open water.
const SAFE_WADE_DEPTH = 1.5;

// 30 clears the tallest crown (~17) and any roof while leaving a flight or a fall outside it; below 0.5 the perch and the ground are the same place.
const MAX_PERCH_RISE = 30;
const PERCH_MIN_RISE = 0.5;

// The closest ground a hero can stand on at (x, z), or a town gate. The saved height is never trusted
// — a save can be taken flying or on a deck that has moved — so it is resolved at capture AND at load.
// `perchY` comes back as a bounded RISE above the ground that is there NOW, and is deliberately not
// checked against `climbTopAt`: the trunk registry arrives with the chunk, after the load.
function resolveSafeGround(
  x: number,
  z: number,
  perchY = NaN,
): { x: number; y: number; z: number } {
  if (Number.isFinite(x) && Number.isFinite(z)) {
    const ground = world.getHeight(x, z);
    if (Number.isFinite(ground) && ground >= world.waterLevel - SAFE_WADE_DEPTH) {
      const floor = Math.max(ground, world.waterLevel);
      // NaN fails this, which is how "he was on the ground" arrives.
      if (perchY > floor) {
        return { x, y: Math.min(perchY, floor + MAX_PERCH_RISE), z };
      }
      return { x, y: floor, z };
    }
  }
  // The gate rather than the centre: the point a layout treats as "the way in".
  const town =
    Number.isFinite(x) && Number.isFinite(z) ? world.towns.nearest(x, z) : world.towns.all[0];
  const ax = town?.gateX ?? world.spawnPoint.x;
  const az = town?.gateZ ?? world.spawnPoint.z;
  return { x: ax, y: Math.max(world.getHeight(ax, az), world.waterLevel), z: az };
}

function resolveOnCarrier(
  loc: SaveDocument["location"],
): { x: number; y: number; z: number; yaw: number } | null {
  if (loc.carrierId === undefined || loc.localX === undefined || loc.localZ === undefined) {
    return null;
  }
  const carrier = world.carriers.get(loc.carrierId);
  if (!carrier) {
    return null;
  }
  const out = { x: 0, z: 0 };
  carrier.toWorld(loc.localX, loc.localZ, out);
  // Asked of the carrier rather than reconstructed from a stored height; -Infinity means it has nothing at that column any more.
  const top = carrier.topAt(out.x, out.z);
  if (!Number.isFinite(top)) {
    return null;
  }
  return { x: out.x, y: top, z: out.z, yaw: loc.yaw + carrier.yaw };
}

function collectSave(): SaveDocument {
  const here = resolveSafeGround(player.position.x, player.position.z);
  // Riding something? Then the spot on IT is durable and the world coords are the fallback.
  const carrier = player.carrier;
  const local = carrier ? { x: 0, z: 0 } : null;
  if (carrier && local) {
    carrier.toLocal(player.position.x, player.position.z, local);
  }
  // Standing on something that is not the ground: `onGround` makes this a perch rather than an altitude.
  const perchY =
    player.onGround && !player.isMounted && player.position.y > here.y + PERCH_MIN_RISE
      ? player.position.y
      : null;
  const saved: SaveDocument = {
    v: 1,
    name: playerName,
    player: { hp: player.hp, maxHp: player.maxHp },
    location: {
      zoneId: zones.id,
      x: here.x,
      y: here.y,
      z: here.z,
      // Relative to the carrier: a deck that turns takes the street he stood in with it.
      yaw: carrier ? player.facing - carrier.yaw : player.facing,
      ...(perchY !== null ? { perchY } : {}),
      ...(carrier && local ? { carrierId: carrier.id, localX: local.x, localZ: local.z } : {}),
    },
    // The NET purse; `pickupTotal` and `spent` mean nothing on their own.
    currency: shards(),
    bag: bag.toJSON(),
    slots: slots.toJSON(),
    equippedWeapon,
    readiedOrb,
    beasts: ownedBeasts().map((b) => ({
      id: b.id,
      speciesId: b.species.id,
      level: b.level,
      xp: b.xp,
      xpToNext: b.xpToNext,
      hp: b.hp,
      knownSkillIds: [...b.knownSkillIds],
    })),
    party: {
      primary: primary()?.id ?? null,
      support: support()?.id ?? null,
    },
    appearance: {
      hairStyle: player.hairStyle,
      hairColour: player.hairColour.toString(16).padStart(6, "0"),
    },
    mounts: mountUnlocks.list(),
    content: content.state.toJSON(),
    dayPhase: dayNight.phase,
    ...(playerMarker ? { marker: { ...playerMarker } } : {}),
    explored: exploration.toJSON(),
  };
  if (carriedExtra) {
    saved.extra = carriedExtra;
  }
  return saved;
}

function applySave(doc: SaveDocument): void {
  applyingSave = true;
  try {
    playerName = doc.name;
    carriedExtra = doc.extra;

    // 1. THE ZONE. One this build no longer has resolves to the overworld.
    const target = zones.zoneIds.includes(doc.location.zoneId) ? doc.location.zoneId : "overworld";
    if (zones.id !== target) {
      zones.switchTo(target);
    }
    // A load replaces the session, so a walk in flight ends the way exitToTitle
    // ends it: everyone back at his placement, the objective's progress restored
    // below deciding whether the walk is still owed.
    world.npcs?.cancelEscorts();

    // 2. THE FACTS. Tolerant of ids it cannot resolve, and its change notification is what re-derives the journal, the tracker and any quest time-of-day pin.
    content.state.fromJSON(doc.content);

    // 3. The clock, after the facts, so a quest's time-of-day override still outranks it.
    dayNight.setPhase(doc.dayPhase);

    mountUnlocks.restore(doc.mounts);

    // The map marker: a zone this build no longer has drops the flag, never the load.
    playerMarker = doc.marker && zones.zoneIds.includes(doc.marker.zone) ? { ...doc.marker } : null;
    syncMarkerChip();
    // The ground he has seen: a zone this build no longer has is dropped, the rest loads.
    exploration.fromJSON(doc.explored, zones.zoneIds);

    // 4. THE PARTY. Reset first: the roster holds every species, bonded or not.
    for (const b of roster) {
      b.reset();
    }
    owned.clear();
    primaryIdx = -1;
    supportIdx = -1;
    // A species this build no longer ships is skipped. A document from before issue #110 names no body,
    // and its one beast of a species IS the boot body, whose id is the species id.
    for (const s of doc.beasts) {
      grantBeast(s.speciesId, s.id ?? s.speciesId)?.restore(s);
    }
    // By BODY ID, so adding a species cannot repoint an old save at another companion.
    const slotOf = (id: string | null): number =>
      id !== null && owned.has(id) ? roster.findIndex((b) => b.id === id) : -1;
    primaryIdx = slotOf(doc.party.primary);
    supportIdx = slotOf(doc.party.support);
    // Repairs: a character with no resolvable beast at all is granted the starter.
    if (owned.size === 0) {
      grantBeast(STARTER_BEAST);
    } else if (primaryIdx < 0) {
      primaryIdx = roster.findIndex(isOwned);
    }
    if (supportIdx === primaryIdx) {
      supportIdx = -1;
    }
    refreshVisibility();
    cooldowns.clear();

    // 5. The purse through its owner, which emits and so updates the HUD.
    spent = 0;
    combat.setShards(doc.currency);

    // 6. THE WALL BEFORE THE BAG: `reconcile` hands an unplaced row the first free cell, so a bag restored into
    // an empty layout would discard where the player had put things.
    slots.fromJSON(doc.slots);
    bag.clear();
    for (const [id, count] of doc.bag) {
      if (isKnownItem(id) && count > 0) {
        bag.add(id, count);
      }
    }

    // 7. The loadout: only what is still a real item AND actually in the bag.
    equippedWeapon =
      doc.equippedWeapon !== null &&
      isKnownItem(doc.equippedWeapon) &&
      bag.count(doc.equippedWeapon) > 0
        ? doc.equippedWeapon
        : null;
    readiedOrb =
      doc.readiedOrb !== null && isKnownItem(doc.readiedOrb) && bag.count(doc.readiedOrb) > 0
        ? doc.readiedOrb
        : null;
    attackBuff = 0;
    attackBuffT = 0;
    applyLoadout();
    refreshBagChips();
    refreshOrbHud();

    const hex = parseInt(doc.appearance.hairColour, 16);
    player.setHair(doc.appearance.hairStyle, Number.isFinite(hex) ? hex : null);

    // 9. PLACEMENT LAST, over the spawn point the zone switch left him on.
    mount.dismount();
    const at = resolveOnCarrier(doc.location) ?? {
      ...resolveSafeGround(doc.location.x, doc.location.z, doc.location.perchY),
      yaw: doc.location.yaw,
    };
    mount.teleport(at.x, at.z, at.y);
    player.restore(doc.player.hp, at.x, at.y, at.z, at.yaw);

    inventory.refresh();
  } finally {
    // A throw must not leave this set, or every autosave for the session is skipped.
    applyingSave = false;
  }
}

async function saveNow(): Promise<number | null> {
  if (!playing || !savesAvailable()) {
    return null;
  }
  const epoch = saveEpoch;
  const write = writeSave(activeSaveId, collectSave());
  lastWrite = write.catch(() => null);
  const id = await write;
  // Only if this is still the character it was written for. See `saveEpoch`.
  if (epoch === saveEpoch) {
    activeSaveId = id;
  }
  return id;
}

// WHEN IT SAVES (issue #171): the event writes — a quest changing state, the exit to title — protect
// progress, and the interval is the backstop. Turning the timer off does not turn saving off.

/** Seconds since the last write. Reset by every save, whatever triggered it. */
let sinceSave = 0;
// Seconds left on the debounce after a quest changed, 0 when nothing is pending.
let questSaveIn = 0;
const QUEST_SAVE_DEBOUNCE = 2;

// ?autosaveSec=<n> — the same accumulator and comparison in SECONDS, so testing the timer does not cost a minute or reach past the path a player is on.
const autosaveOverrideSec = (() => {
  const raw = new URLSearchParams(window.location.search).get("autosaveSec");
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
})();

// Its own read: the `prefs` const is thousands of lines below and would be in its dead zone.
let autosaveMinutes = loadPrefs().autosaveMinutes;

/** The interval in seconds, or 0 for "no timer". */
function autosavePeriod(): number {
  if (autosaveOverrideSec !== null) {
    return autosaveOverrideSec;
  }
  return autosaveMinutes > 0 ? autosaveMinutes * 60 : 0;
}

// Ask for a write. The refusals are the point: `applyingSave` stops a load writing back what it just read, and a DEAD hero is not a state to come back to.
function autosave(): void {
  sinceSave = 0;
  questSaveIn = 0;
  if (!playing || applyingSave || player.isDead || !savesAvailable()) {
    return;
  }
  void saveNow();
}

/** Called once per SIMULATION SLICE from `simulate()` — see the note there. */
function tickAutosave(dt: number): void {
  if (!playing) {
    return;
  }
  if (questSaveIn > 0) {
    questSaveIn -= dt;
    if (questSaveIn <= 0) {
      autosave();
      return;
    }
  }
  const period = autosavePeriod();
  if (period <= 0) {
    return;
  }
  sinceSave += dt;
  if (sinceSave >= period) {
    autosave();
  }
}

// A quest changing state is the only real-progress signal the engine has — there are no quest events on the bus.
content.state.onChange((what) => {
  if (what.kind !== "quest" || !playing || applyingSave) {
    return;
  }
  questSaveIn = QUEST_SAVE_DEBOUNCE;
});

// Readers for the list and the document, drivers for the round trip. Same argument as __dbgTp.
(
  window as unknown as {
    __dbgSaves: {
      list: () => Promise<SaveMeta[]>;
      read: (id: number) => Promise<SaveDocument | null>;
      doc: () => SaveDocument;
      save: (name?: string) => Promise<number | null>;
      newCharacter: (name: string) => void;
      load: (id: number) => Promise<boolean>;
      del: (id: number) => Promise<void>;
      active: () => number | null;
      available: () => boolean;
      autosave: () => { minutes: number; periodSec: number; sinceSec: number; questIn: number };
    };
  }
).__dbgSaves = {
  list: () => listSaves(),
  read: (id) => readSave(id),
  doc: () => collectSave(),
  // Writes THE CHARACTER BEING PLAYED, renaming when a name is given, so calling it twice updates one record.
  save: async (name) => {
    if (name !== undefined) {
      playerName = name;
    }
    return saveNow();
  },
  // What New Game does to the save pointer, without the title screen.
  newCharacter: (name) => {
    playerName = name;
    setActiveSave(null);
    carriedExtra = undefined;
  },
  // Applies INTO the running session; the menu path is the same `applySave` behind beginPlay.
  load: async (id) => {
    const doc = await readSave(id);
    if (!doc) {
      return false;
    }
    applySave(doc);
    setActiveSave(id);
    return true;
  },
  del: async (id) => {
    if (activeSaveId === id) {
      setActiveSave(null);
    }
    await deleteSave(id);
  },
  active: () => activeSaveId,
  available: () => savesAvailable(),
  // What the timer thinks, so a probe asserts on state rather than on a wall-clock moment.
  autosave: () => ({
    minutes: autosaveMinutes,
    periodSec: autosavePeriod(),
    sinceSec: +sinceSave.toFixed(2),
    questIn: +questSaveIn.toFixed(2),
  }),
};

// Phase 1 ends here; everything past this point is phase 2.
await loading?.stage("world");

// CONTENT, first in the world phase: it must precede `createWorld`, because `planSettlements` reads
// `content.all('town')`, and at ~2.4 ms against a ~390 ms world it deserves no chip of its own.
// It does not throw — `ok === false` means a broken package; findings via __dbgContent / /content check.
const contentBootStart = performance.now();
content.addProvider(new BundledProvider());
// ABOVE THE BOOT: registering a factory publishes its name to the validator, and the cross-asset pass
// runs inside `bootstrapContent`. A URL rather than a builder, so content names a song and not a path.
for (const [name, url] of Object.entries(MUSIC_TRACKS)) {
  content.defineFactory(MUSIC_TRACK_KIND, name, url);
}
// The seam a quest turn-in lands on, and the only way a QUEST item is reachable in play.
content.defineAction("item.give", (params) => {
  const id = params.item;
  if (typeof id !== "string" || !isKnownItem(id)) {
    return;
  }
  const raw = params.count;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
  giveItemFromContent(id, n);
});
// THE STORY HANDING OVER A MOUNT (game-story.md §6). The ACTION changes what the player can do and
// the quest's own `flag.set mount-ground` is what other content may test — a quest emits both, and
// this handler deliberately sets no flag, so the two never disagree about which one is authoritative.
const MOUNT_UNLOCK_KEYS: Record<MountKind, StringKey> = {
  ground: "toast.mountUnlocked.ground",
  water: "toast.mountUnlocked.water",
  flying: "toast.mountUnlocked.flying",
};
content.defineAction("mount.unlock", (params) => {
  const kind = MOUNT_KINDS.find((k) => k === params.kind);
  if (kind === undefined || mountUnlocks.has(kind)) {
    return;
  }
  mountUnlocks.set(kind, true);
  bus.emit({ type: "toast", text: t(MOUNT_UNLOCK_KEYS[kind]) });
});
// THE ESCORT SEAM (issue #234). The action names WHO walks; WHERE TO lives on the
// quest objective's own `escort` trigger (a `site` or a `town`), so the walk and
// the objective it completes cannot disagree about the destination. The engine
// half is `Npcs.startEscort` (world/npc.ts): follow the hero, leash-teleport a
// follower left behind, re-station on arrival. He cannot be hurt (#155's
// documented decision, kept) — the leash is the escort's whole failure model.
/** Arrival radius: the walk ends when the FOLLOWER is this near the destination. */
const ESCORT_ARRIVE = 6;
content.defineAction("escort.start", (params) => {
  const npcId = params.npc;
  if (typeof npcId !== "string" || !npcId.startsWith("npc:")) {
    return;
  }
  const bare = npcId.slice("npc:".length);
  for (const questId of content.state.activeQuests) {
    const asset = content.get<QuestData>(questId);
    for (const objective of asset?.data.objectives ?? []) {
      const trigger = objective.trigger;
      if (!trigger || trigger.kind !== "escort" || trigger.npc !== npcId) {
        continue;
      }
      if (content.state.progress(questId, objective.key) >= (objective.count ?? 1)) {
        continue;
      }
      let dest: { x: number; z: number } | null = null;
      if (trigger.site !== undefined) {
        dest = questSite(trigger.site);
      } else if (trigger.town !== undefined) {
        const town = world.towns.get(trigger.town.slice("town:".length));
        dest = town ? { x: town.gateX, z: town.gateZ } : null;
      }
      if (!dest) {
        reportContentIssue({
          severity: "error",
          code: "unsupported",
          message: `escort.start for "${npcId}" has no resolvable destination`,
          assetId: questId,
          assetType: "quest",
          field: `data.objectives[${objective.key}].trigger`,
          fix: `name a staged site (${QUEST_SITE_NAMES.join(", ")}) or a town on the escort trigger`,
        });
        return;
      }
      const already = world.npcs?.escorting(bare) ?? false;
      const ok =
        world.npcs?.startEscort(bare, dest.x, dest.z, ESCORT_ARRIVE, () => {
          advanceObjectives({ kind: "escort", id: npcId });
          bus.emit({ type: "toast", text: t("toast.escortDone", { name: escortName(bare) }) });
        }) ?? false;
      if (!ok) {
        reportContentIssue({
          severity: "error",
          code: "unsupported",
          message: `escort.start could not walk "${npcId}" — not in this zone, or on a moving frame`,
          assetId: questId,
          assetType: "quest",
          fix: "escort a ground-placed NPC in the zone the dialogue runs in",
        });
      } else if (!already) {
        bus.emit({ type: "toast", text: t("toast.escortStarted", { name: escortName(bare) }) });
      }
      return;
    }
  }
});

function escortName(bareId: string): string {
  const who = world.npcs?.all.find((n) => n.id === bareId);
  return who ? t(who.nameKey) : "";
}

/** The staged sites content may SELECT by name — the same spots `__dbgQuestSites` reads. */
const QUEST_SITE_NAMES = ["vane-wreck", "maws-rest", "drove-ground", "hold-floor"] as const;

function questSite(name: string): { x: number; z: number } | null {
  switch (name) {
    case "vane-wreck":
      return vaneWreck();
    case "maws-rest":
      return mawsRest();
    case "drove-ground":
      return droveGround();
    case "hold-floor":
      return holdFloorSpot();
    default:
      return null;
  }
}
// THE CAMPAIGN LOADS AT BOOT: ZoneManager builds its starting zone directly, so an "on arrival in
// overworld" hook never fires on a fresh game, and quest 4's definitions must be resident in `hold`.
const contentBoot = await bootstrapContent({
  engineFlags: [],
  // `story-sea` at boot, not on its act's flag: Act 2 is part of the open world
  // (issue #144), so its island settlements must exist when `planSettlements`
  // runs — the geography is always there; `sea-revealed` opens the FERRY.
  packages: ["story", "story-land", "story-sea"],
});
/** What the phase above cost. Reported by `__dbgContent`; see the note there. */
const contentBootMs = performance.now() - contentBootStart;

// AN ACT'S PACKAGE LOADS ON THE FLAG THAT OPENS THE ACT (issue #209) — unless the act is part of
// the open world, in which case its settlements must exist when the world is planned and the
// package moves to the boot list above (issue #144: `story-sea` did exactly that). The mechanism
// stays for a future act whose content CAN arrive late; today the list is empty. Loaded ONCE and
// never released mid-session: progress lives in ContentState either way, and `exitToTitle` clears
// the FACTS, after which nothing gates on the resident definitions.
const ACT_PACKAGES: readonly { flag: string; pkg: string }[] = [];
const actPackagesLoaded = new Set<string>();
function syncActPackages(): void {
  for (const act of ACT_PACKAGES) {
    if (actPackagesLoaded.has(act.pkg) || !content.state.flag(act.flag)) {
      continue;
    }
    actPackagesLoaded.add(act.pkg);
    // Async, and nothing awaits it: the definitions announce themselves through
    // `onDefinitionsChange`, which is the same door a `/content load` uses. The
    // `event` lease is the honest one — the load was triggered by a story event.
    void content.load(act.pkg, "event");
  }
}
// On every flag change — including the ones a LOADED SAVE replays — and once now,
// so a session restored past the seam has its act resident before the first frame.
content.state.onChange((change) => {
  if (change.kind === "flag") {
    syncActPackages();
  }
});
syncActPackages();

// Derived from content facts, never pushed by quest actions, so a load recomputes the same answer.
let reportedTimeConflict = "";
const refreshQuestTime = (): void => {
  const locks = content.state.activeQuests.flatMap((id) => {
    const asset = content.get<QuestData>(id);
    return asset?.data.timeOfDay === undefined ? [] : [{ id, phase: asset.data.timeOfDay, asset }];
  });
  if (locks.length === 0) {
    dayNight.setQuestOverride(null, null);
    reportedTimeConflict = "";
    return;
  }
  locks.sort((a, b) => a.id.localeCompare(b.id));
  const winner = locks[0];
  dayNight.setQuestOverride(winner.id, winner.phase);
  const values = [...new Set(locks.map((x) => x.phase))];
  const signature = locks.map((x) => `${x.id}@${x.phase}`).join("|");
  if (values.length > 1 && signature !== reportedTimeConflict) {
    reportedTimeConflict = signature;
    reportContentIssue({
      severity: "warn",
      code: "quest-time-conflict",
      message: `Active quest time locks conflict; using "${winner.id}" at ${winner.phase}`,
      assetId: winner.asset.id,
      assetType: winner.asset.type,
      pkg: winner.asset.pkg,
      source: winner.asset.source,
      field: "timeOfDay",
      fix: "keep simultaneously active quests on one timeOfDay value",
    });
  }
};
content.state.onChange((change) => {
  if (change.kind === "quest" || change.kind === "reset") {
    refreshQuestTime();
  }
});
content.onDefinitionsChange(refreshQuestTime);
refreshQuestTime();

// Applied before the first chunk: `setArea` fires the change listener and there is no world to rebuild.
for (const biome of content.all<BiomeData>("biome")) {
  const area = biome.id.slice(biome.type.length + 1) as NatureAreaId;
  for (const [param, value] of Object.entries(biome.data.nature)) {
    nature.setArea(area, param as NatureParamId, value);
  }
}

/** Offsets probed for level ground under the gateway. */
const GATE_PROBES: ReadonlyArray<readonly [number, number]> = [
  [3, 0],
  [-3, 0],
  [0, 3],
  [0, -3],
  [2, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
];

// In preference order. The lower bound is load-bearing — the preload band is 30 wide, so anything
// closer builds the dungeon at boot — and 150+ makes the arch somewhere you SET OUT for.
const GATE_RADII = [170, 195, 150, 210] as const;

// Where the overworld's gateway stands: scored on level, dry ground clear of the dens and towns — half an arch
// buried in a hillside reads as a bug rather than a landmark.
function findGateSpot(w: LandmarkProbe): { x: number; z: number } {
  const base = w.spawnPoint;
  let best = { x: base.x + GATE_RADII[0] + 0.5, z: base.z + 0.5 };
  let bestScore = Infinity;
  for (const radius of GATE_RADII) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + 0.9;
      const x = Math.round(base.x + Math.cos(a) * radius) + 0.5;
      const z = Math.round(base.z + Math.sin(a) * radius) + 0.5;
      const h = w.getHeight(x, z);
      if (h < w.waterLevel + 1) {
        continue;
      }
      let worst = 0;
      for (const [dx, dz] of GATE_PROBES) {
        worst = Math.max(worst, Math.abs(w.getHeight(x + dx, z + dz) - h));
      }
      let shopPenalty = 0;
      for (const s of w.shopPositions) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 12) {
          shopPenalty += 12 - d;
        }
      }
      // A town is far bigger than a den, so its penalty is its own footprint plus clearance.
      for (const town of w.towns.all) {
        const keep = town.radius + 10;
        const d = Math.hypot(town.x - x, town.z - z);
        if (d < keep) {
          shopPenalty += (keep - d) * 3;
        }
      }
      // A wood around it and a hill BEHIND it, sampled on the far side so the arch still gets level ground.
      // Preferences, not filters. There is no MOUNTAIN biome (issue #142 §11e), so a hill is a steepness reading.
      const away = Math.atan2(z - base.z, x - base.x);
      const backX = x + Math.cos(away) * 9;
      const backZ = z + Math.sin(away) * 9;
      const backing = Math.min(1, w.steepnessAt(backX, backZ) / 0.45);
      const wooded = w.biomeAt(x, z) === "forest" ? 1 : 0;
      // A TRAIL CANNOT BRIDGE, so a site across water has no way to it (issue #184).
      let wet = 0;
      {
        const dx = x - base.x;
        const dz = z - base.z;
        const steps = Math.max(1, Math.round(Math.hypot(dx, dz) / 2));
        for (let i = 1; i < steps; i++) {
          const frac = i / steps;
          if (w.getHeight(base.x + dx * frac, base.z + dz * frac) < w.waterLevel + 0.5) {
            wet++;
          }
        }
      }
      // Weighted under `worst * 3` so level footing still wins; the crossing term outweighs both preferences, because you cannot get to a site you cannot walk to.
      const score = worst * 3 + shopPenalty - backing * 2.5 - wooded * 2 + wet * 6;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
      if (score === 0) {
        return best;
      }
    }
  }
  return best;
}

// Further out than the Hold's arch: the coast is somewhere you SET OUT for. Same
// lower bound rule as GATE_RADII.
const COAST_RADII = [260, 300, 220, 340, 380, 420] as const;

/**
 * Where Embervale's ferry pier stands: a shore column with open water at its back.
 * `findGateSpot`'s rules inverted — that one pays 6 a wet column between spawn and
 * site because a trail cannot bridge; this one REQUIRES the water, seaward of the
 * pier, so the way to it still walks dry and the pier reads as a door onto the sea.
 * Coastline-facing sites win, because that is the sea the ferry actually sails.
 */
function findPierSpot(w: LandmarkProbe): { x: number; z: number } {
  const base = w.spawnPoint;
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;
  for (const radius of COAST_RADII) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + 0.37;
      const x = Math.round(base.x + Math.cos(a) * radius) + 0.5;
      const z = Math.round(base.z + Math.sin(a) * radius) + 0.5;
      const h = w.getHeight(x, z);
      // The pad itself is dry beach: low enough to be a shore, never a clifftop.
      if (h < w.waterLevel + 1 || h > w.waterLevel + 3) {
        continue;
      }
      let worst = 0;
      for (const [dx, dz] of GATE_PROBES) {
        worst = Math.max(worst, Math.abs(w.getHeight(x + dx, z + dz) - h));
      }
      // Open water SEAWARD of the pier — sampled away from spawn, 6..30 out, three bearings.
      const away = Math.atan2(z - base.z, x - base.x);
      let wet = 0;
      let samples = 0;
      for (const spread of [-0.4, 0, 0.4]) {
        for (let d = 6; d <= 30; d += 4) {
          samples++;
          if (
            w.getHeight(x + Math.cos(away + spread) * d, z + Math.sin(away + spread) * d) <
            w.waterLevel
          ) {
            wet++;
          }
        }
      }
      if (wet < samples * 0.6) {
        continue;
      }
      let crowd = 0;
      for (const s of w.shopPositions) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 12) {
          crowd += 12 - d;
        }
      }
      for (const town of w.towns.all) {
        const keep = town.radius + 10;
        const d = Math.hypot(town.x - x, town.z - z);
        if (d < keep) {
          crowd += (keep - d) * 3;
        }
      }
      // The WALK to it must still be dry — the same no-bridge rule as the Hold's arch.
      let landWet = 0;
      {
        const dx = x - base.x;
        const dz = z - base.z;
        const steps = Math.max(1, Math.round(Math.hypot(dx, dz) / 2));
        for (let i = 1; i < steps; i++) {
          const frac = i / steps;
          if (w.getHeight(base.x + dx * frac, base.z + dz * frac) < w.waterLevel + 0.5) {
            landWet++;
          }
        }
      }
      // Alignment with the coastline half-plane: the Reach lies down SEA_DIR.
      const seaward = Math.max(0, (x - base.x) * SEA_DIR.x + (z - base.z) * SEA_DIR.z);
      const score = worst * 3 + crowd + landWet * 6 - (wet / samples) * 4 - seaward * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    if (best && bestScore < 2) {
      break;
    }
  }
  if (best) {
    return best;
  }
  // No open water in range: any shore column keeps the pier standing somewhere.
  for (const radius of COAST_RADII) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + 0.37;
      const x = Math.round(base.x + Math.cos(a) * radius) + 0.5;
      const z = Math.round(base.z + Math.sin(a) * radius) + 0.5;
      const h = w.getHeight(x, z);
      if (h >= w.waterLevel + 1 && h <= w.waterLevel + 4) {
        return { x, z };
      }
    }
  }
  return { x: base.x + 300.5, z: base.z + 0.5 };
}

// Chosen inside createWorld (so the terrain can be flattened and props kept off) and read back by `gates` and the ferry; a handoff rather than two scans that could disagree.
let gateSite: { x: number; z: number } | null = null;
let pierSite: { x: number; z: number } | null = null;

// The zone id is the identity; only `name` is display, and a GETTER because the language can change after these are built.
const OVERWORLD: ZoneDef = {
  id: "overworld",
  get name() {
    return t("zone.overworld.name");
  },
  create: (scene) =>
    createWorld(
      scene,
      1337,
      (probe) => {
        gateSite = findGateSpot(probe);
        pierSite = findPierSpot(probe);
        // Both landmarks ask for a keep-out: an animal spawning beside a player held at the threshold by a preload is an ambush the game arranged.
        return [
          { ...gateSite, id: "landmark:gateway", noSpawnRadius: 12 },
          { ...pierSite, id: "landmark:pier", noSpawnRadius: 12 },
        ];
      },
      Number(storedGfx("terrainDistance")),
    ),
  gates: () => [{ to: "hold", x: gateSite!.x, z: gateSite!.z, hex: 0x8be3ff }],
};

const HOLD: ZoneDef = {
  id: "hold",
  get name() {
    return t("zone.hold.name");
  },
  create: (scene) => createDungeon(scene, 0x5ea1ed),
  // You arrive ON the return gateway, which is why it starts disarmed (see EXIT_R).
  gates: (w) => [{ to: "overworld", x: w.spawnPoint.x, z: w.spawnPoint.z, hex: 0xffc46b }],
  // A dungeon is a side trip; the overworld is where you live (issue #211).
  keepReturn: true,
};

/** Everything that captured a World at construction; rebound on every switch. */
const bound: WorldBound[] = [];
/** Set by the zone manager each slice; consumed by the HUD hint below. */
let portalHint: string | null = null;

// Hoisted: `t(key, vars)` allocates and the loop shows this every frame near a den. `composeKeyHints()` is the one writer.
let skillDenHint = "";

const zones = new ZoneManager({
  scene: engine.scene,
  zones: [OVERWORLD, HOLD],
  start: "overworld",
  bind: bound,
  warm: (stage, lights) => warmUpFrame(stage, lights),
  onArrive: (w, def) => {
    world = w;
    world.applyCelestial(dayNight);
    // A ZONE ID IS A SCENE NAME: `musicPlaylist` looks for `music:<id>` and takes the fallback
    // otherwise, so a zone added later brings its music and this line never grows a branch.
    music.setScene(def.id);
    // A saddle pose is computed against one world's heightfield — the teleport-into-rock case.
    if (mount.isMounted) {
      mount.dismount();
    }
    player.position.copy(w.spawnPoint);
    player.position.y = Math.max(w.getHeight(w.spawnPoint.x, w.spawnPoint.z), w.waterLevel);
    player.velocity.set(0, 0, 0);
    // No placement needed: follow-update teleports any beast further than TELEPORT_DIST away.
    bus.emit({ type: "toast", text: t("toast.enteredZone", { zone: def.name }) });
    // The stones are the zone's, and a new zone's are dark until they are asked.
    w.waypoints?.setLit(waypointLit);
    // ARRIVAL, for a quest that sent you here. Below the placement, so anything reading the fact sees
    // the hero already standing in the zone; `discover` is the zone's own id and not a town's.
    content.state.discover(`zone:${def.id}`);
    advanceObjectives({ kind: "zone-arrival", id: def.id });
    // Quest chips are recomputed rather than copied, because the waypoint for "reach the Hold" is
    // a different door from either side of it. The marker chip is per-zone too.
    refreshQuestChips();
    syncMarkerChip();
    // A new zone is new meshes, and a visibility flag went with the old world's chunks.
    gfx.applyAll();
  },
  onHint: (hint) => {
    portalHint = hint;
  },
  // The same cap the den and the NPC prompts carry, so one rebind moves all three.
  interactKey: () => hud.interactPrompt,
});

await loading?.stage("actors");

let world: World = zones.world;

// THE FERRY (issue #144): Act 2 is part of the open world, and this is its first
// crossing — Embervale's pier to Saltrest's quay, both piers of THIS world.
// `sea-revealed` moors the boats; nothing here switches a zone or an instance.
const ferry: Ferry | null = (() => {
  const saltrest = world.towns.get("saltrest");
  // Assigned inside `createWorld`'s landmarks callback, which flow analysis cannot see.
  const p = pierSite as { x: number; z: number } | null;
  if (!p || !saltrest) {
    return null;
  }
  // The pier's boat floats on the spawn-away side — the side the open water is on
  // (findPierSpot required it); Saltrest's floats off its quay, along gateAngle.
  const away = Math.atan2(p.z - world.spawnPoint.z, p.x - world.spawnPoint.x);
  return new Ferry(
    engine.scene,
    [
      {
        id: "pier",
        x: p.x,
        z: p.z,
        y: world.getHeight(p.x, p.z),
        boatX: p.x + Math.cos(away) * 8,
        boatZ: p.z + Math.sin(away) * 8,
      },
      // The harbour layout says where its pier head is (#228); the gate is the
      // fallback for a world whose saltrest is not a harbour (towns=0 A/Bs).
      (() => {
        const port = world.portOf("saltrest");
        return port
          ? { id: "saltrest", ...port }
          : {
              id: "saltrest",
              x: saltrest.gateX,
              z: saltrest.gateZ,
              y: world.getHeight(saltrest.gateX, saltrest.gateZ),
              boatX: saltrest.gateX + Math.sin(saltrest.gateAngle) * 8,
              boatZ: saltrest.gateZ + Math.cos(saltrest.gateAngle) * 8,
            };
      })(),
    ],
    SURFACE_Y,
    () => content.state.flag("sea-revealed"),
  );
})();

/** Where a sail is headed, from press to fade-in; null when nobody is sailing. */
let sail: { to: FerryStop; phase: "out" | "wait" | "in"; t: number } | null = null;

// The sail's blackout: a full-screen layer sized from --bs-vw/--bs-vh, opacity
// driven per frame so it follows the sim clock rather than a CSS timeline.
const sailFade = document.createElement("div");
sailFade.className = "bs-sail";
sailFade.style.cssText =
  "position:fixed;left:0;top:0;width:var(--bs-vw,100vw);height:var(--bs-vh,100vh);" +
  "background:#04070c;opacity:0;display:none;z-index:30;pointer-events:none;" +
  "align-items:center;justify-content:center;color:#cfe8e2;" +
  "font:600 max(16px,2.2vh) system-ui,sans-serif;letter-spacing:0.08em;";
const sailCaption = document.createElement("div");
sailFade.appendChild(sailCaption);
document.body.appendChild(sailFade);

/** What the sail caption and pier hint call a destination. Looked up per call — live language. */
function ferryStopName(stop: FerryStop): string {
  return stop.id === "saltrest" ? t("town.saltrest.name") : t("zone.overworld.name");
}

const SAIL_OUT_S = 0.5;
const SAIL_IN_S = 0.7;
/** The far quay must stream before the fade lifts; this is the give-up, not the norm. */
const SAIL_WAIT_MAX_S = 15;

function startSail(to: FerryStop): void {
  sail = { to, phase: "out", t: 0 };
  sailCaption.textContent = t("hint.sailing", { place: ferryStopName(to) });
  sailFade.style.opacity = "0";
  sailFade.style.display = "flex";
}

function tickSail(dt: number): void {
  if (sail === null) {
    return;
  }
  sail.t += dt;
  if (sail.phase === "out") {
    sailFade.style.opacity = String(Math.min(1, sail.t / SAIL_OUT_S));
    if (sail.t >= SAIL_OUT_S) {
      // Blacked out: move the pair. A boat carries no mount, and the quay is ground.
      if (mount.isMounted) {
        mount.dismount();
      }
      player.position.set(sail.to.x, sail.to.y + 0.4, sail.to.z);
      player.velocity.set(0, 0, 0);
      sail.phase = "wait";
      sail.t = 0;
    }
  } else if (sail.phase === "wait") {
    if ((!world.streaming && sail.t > 0.3) || sail.t > SAIL_WAIT_MAX_S) {
      sail.phase = "in";
      sail.t = 0;
    }
  } else {
    sailFade.style.opacity = String(Math.max(0, 1 - sail.t / SAIL_IN_S));
    if (sail.t >= SAIL_IN_S) {
      sailFade.style.display = "none";
      const to = sail.to;
      sail = null;
      ferry?.arrived(to);
      // FIRST LANDFALL IS THE ACT'S DOOR: one discovery, one banner toast. The
      // town-arrival objective fires from syncTownArrival on its own.
      if (to.id === "saltrest" && !content.state.discovered("region:brine")) {
        content.state.discover("region:brine");
        bus.emit({ type: "toast", text: t("toast.enteredZone", { zone: t("region.brine.name") }) });
      }
    }
  }
}

// Zone-agnostic — the world is only a per-frame "is there water under the lens" answer — so it survives a switch without being in `bound`.
const underwater = new Underwater(engine.scene, engine.camera, engine.renderer.domElement);
const player = new Player(engine, world, input, bus);
// WHERE A FAINT PUTS HIM BACK: the nearest stone this character has lit, or the world's own spawn when
// he has lit none — which is what it always was. The policy is here and not in Player because "lit" is
// a content fact and the player may not read one.
player.respawnAt = (x, z) => world.waypoints?.nearestLit(x, z, waypointLit) ?? null;
const combat = new CombatSystem(engine.scene, world, bus);
const hud = new HUD(bus);
// TAPS THE KEY, as the pad's Start and the touch MENU do; the one reader in `frame()` still decides what it means.
hud.onMenu = () => input.tapVirtual("F10");

player.takeStartPose();
// Which weapon is equipped is gear-slot policy and lives in this file; `player.weapon` is read off the RIG, so it cannot disagree with the model.
player.onAttack = (origin, dir) => {
  if (player.weapon === "bow") {
    combat.arrowStrike(origin, dir, player.attackStat);
  } else {
    combat.meleeStrike(origin, dir, player.attackStat, player.position.y);
  }
};

// Cos of the half-angle, ~75 degrees each side.
const AIM_ASSIST_CONE_COS = Math.cos((75 * Math.PI) / 180);
/** Scratch for the crosshair ray below. The strike path allocates nothing. */
const _aimDir = new THREE.Vector3();

// Gameplay policy, so it lives in the composition root. Not gated on device — an assist on one device is a rule players cannot learn. `?aim=0` turns it off.
player.aimAssist = (origin, dir) => {
  if (!flags.aimAssist) {
    return false;
  }
  // NOT FOR THE BOW: the assist searches inside `SWORD_REACH` and snaps the hero's heading so
  // the arc leaves his shoulders, and neither belongs to a shot the crosshair already aimed.
  if (player.weapon === "bow") {
    return false;
  }
  engine.camera.getWorldDirection(_aimDir);
  const target = combat.bestMeleeTarget(
    origin,
    _aimDir,
    SWORD_REACH,
    AIM_ASSIST_CONE_COS,
    player.position.y,
  );
  if (!target) {
    return false;
  }
  const dx = target.position.x - origin.x;
  const dz = target.position.z - origin.z;
  const d = Math.hypot(dx, dz);
  // Standing inside the target: no bearing to steer onto.
  if (d < 1e-4) {
    return false;
  }
  // Horizontal bearing only: in the saddle `dir.y` is what lifts the strike over the mount's bulk (see MOUNTED_REACH).
  const horiz = Math.hypot(dir.x, dir.z);
  dir.x = (dx / d) * horiz;
  dir.z = (dz / d) * horiz;
  return true;
};

// Which landmarks earn a chip is gameplay policy; add one with `hud.addCompassMarker`, the id being
// the identity. The rim carries the next objective and the player's placed marker only (issue #247)
// — town/den/gate chips come back through this same API if a setting re-adds them.

// Empty on a new game — riding is three story unlocks (game-story.md §5). `mounts=` is applied here and nowhere else.
const mountUnlocks = new MountUnlocks();
// Called at boot and again from `exitToTitle`, so `mounts=` means every game of this page load rather than only the first.
function seedMountUnlocks(): void {
  mountUnlocks.reset();
  if (flags.mounts) {
    mountUnlocks.restore(flags.mounts.includes("all") ? MOUNT_KINDS : flags.mounts);
  }
}
seedMountUnlocks();

const mount = new MountController(player, world, input, bus, mountUnlocks);

// Contact particles, constructed above the frame loop so its mesh is in the scene for the boot warm-up: a pool
// first appearing mid-game links a shader and stalls hundreds of ms.
const touchFx = new TouchParticles(engine.scene, world);

// Every species BUILT, none OWNED, two active.
registerSkillDefs(SKILLS.values());
const roster: BeastActor[] = ALL_SPECIES.map((sp) => new BeastActor(sp, engine.scene, world, bus));
// The rebind list. A beast's level, xp and known skills are the save game, so rebuilding one to change zones would delete it.
bound.push(player, mount, combat, touchFx, ...roster);

const owned = new Set<string>();

let primaryIdx = -1;
let supportIdx = -1;
// How near something hostile counts as companions being NEEDED: 22 is "a fight is happening here" rather than "something is on the horizon".
const SUPPORT_CALL_RANGE = 22;
/** Scratch list of live companions handed to combat each slice — never resized. */
const _friendlies: BeastActor[] = [];
const cooldowns = new Map<string, number>();

function primary(): BeastActor | null {
  return primaryIdx >= 0 ? roster[primaryIdx] : null;
}
function support(): BeastActor | null {
  return supportIdx >= 0 ? roster[supportIdx] : null;
}

/** Has the player bonded this one? The one question `owned` is asked. */
function isOwned(b: BeastActor): boolean {
  return owned.has(b.id);
}

// The bonded beasts in roster order — also Tab's order and the panel's.
function ownedBeasts(): BeastActor[] {
  return roster.filter(isOwned);
}

/** Any body of the species bonded — what a quest or the practice pen asks; a bag row asks `isOwned`. */
function ownsSpecies(speciesId: string): boolean {
  return roster.some((b) => b.species.id === speciesId && isOwned(b));
}

/**
 * A second (third…) body of a species (issue #110): built on demand, then KEPT as an unowned spare across
 * a reset — the same reason `BeastActor.reset` is a method and not a rebuild.
 */
function spawnInstance(species: BeastSpecies, id: string): BeastActor {
  const b = new BeastActor(species, engine.scene, world, bus, id);
  b.setVisible(false);
  roster.push(b);
  bound.push(b);
  return b;
}

// `#2`, `#3`… past whatever the roster already holds, so an id in a save stays that beast for good.
function freeInstanceId(speciesId: string): string {
  for (let k = 2; ; k++) {
    const id = `${speciesId}#${k}`;
    if (!roster.some((b) => b.id === id)) {
      return id;
    }
  }
}

// `beasts=0` hides the party and skips its update; it does NOT skip building the rigs, which is a boot cost.
function refreshVisibility(): void {
  roster.forEach((p, i) => p.setVisible(flags.beasts && (i === primaryIdx || i === supportIdx)));
}
refreshVisibility();

// Empty slots first: the first bond leads, the second supports, later ones are benched rather than displacing a chosen beast.
// Every bond is a NEW body with its own level (issue #110): the boot body of the species, else an unowned spare, else
// one built now. `id` is a save's word for which body — honoured when it is free, else the beast is rebuilt under a fresh one.
function grantBeast(speciesId: string, id?: string): BeastActor | null {
  const species = speciesById(speciesId);
  if (!species) {
    return null;
  }
  let b =
    id !== undefined
      ? roster.find((x) => x.id === id && x.species === species)
      : roster.find((x) => x.species === species && !isOwned(x));
  if (b === undefined || isOwned(b)) {
    const fresh = id !== undefined && !roster.some((x) => x.id === id);
    b = spawnInstance(species, fresh ? id : freeInstanceId(speciesId));
  }
  owned.add(b.id);
  const idx = roster.indexOf(b);
  if (primaryIdx < 0) {
    primaryIdx = idx;
  } else if (supportIdx < 0) {
    supportIdx = idx;
  }
  refreshVisibility();
  return b;
}

// Composition-root policy: only this file knows combat, the roster and the content state.
function onBeastTamed(speciesId: string, nameKey: StringKey): void {
  const first = owned.size === 0;
  if (grantBeast(speciesId) === null) {
    return;
  }
  bus.emit({
    type: "toast",
    text: t(first ? "toast.bondedFirst" : "toast.bonded", { beast: t(nameKey) }),
  });
  inventory.refresh();
}

// A silent no-op below two bonded beasts, and `guard` is a trip count because "until it is not the other slot" cannot terminate with one legal index.
function cycleBeast(which: "primary" | "support", dirn: 1 | -1): void {
  const n = roster.length;
  if (owned.size < 2) {
    return;
  }
  const other = which === "primary" ? supportIdx : primaryIdx;
  let idx = which === "primary" ? primaryIdx : supportIdx;
  for (let guard = 0; guard < n; guard++) {
    idx = (idx + dirn + n) % n;
    if (idx !== other && isOwned(roster[idx])) {
      break;
    }
  }
  if (which === "primary") {
    primaryIdx = idx;
  } else {
    supportIdx = idx;
  }
  refreshVisibility();
  const lead = primary();
  const sup = support();
  bus.emit({
    type: "toast",
    text: t("toast.beastLeads", {
      lead: lead ? t(lead.species.nameKey) : t("beast.none"),
      support: sup ? t(sup.species.nameKey) : t("beast.none"),
    }),
  });
}

// Currency: the item id is 'shard' and the event `shardsChanged`; the display name is in i18n.
let pickupTotal = 50;
let spent = 0;
const shards = () => pickupTotal - spent;

// The bag holds everything with a COUNT — currency is the total above and beasts are the roster (core/items.ts).
const bag = new Inventory();

// Where the player put each row on the inventory wall (issue #116).
const slots = new SlotLayout();

// The HUD's chip row is STACKABLES only: it is the readout for the support beast's fetch rule, and the invariant
// is "a chip is up exactly when the beast will fetch more of that".
function refreshBagChips(): void {
  hud.setBag(bag.entriesOfKind("stackable"));
}

bus.on((e) => {
  if (e.type === "shardsChanged") {
    pickupTotal = e.total;
    hud.setShards(shards());
  }
  if (e.type === "itemPicked") {
    const def = itemDef(e.itemId);
    if (def.kind !== "currency") {
      const n = bag.add(e.itemId, 1);
      refreshBagChips();
      if (e.byBeast) {
        // Whichever beast is carrying right now: a Tab swap mid-errand must not misattribute it.
        const fetcher = roster.find((p) => p.isCarrying) ?? support();
        if (fetcher) {
          bus.emit({
            type: "toast",
            text: t("toast.fetched", {
              beast: t(fetcher.species.nameKey),
              item: itemName(def, n),
              n,
            }),
          });
        }
      }
    }
  }
  if (e.type === "enemyKilled") {
    // XP goes to whoever is out there; with no beasts bonded it goes nowhere, correctly.
    primary()?.gainXp(e.xp);
    support()?.gainXp(Math.round(e.xp * 0.6));
  }
  if (e.type === "beastTamed") {
    onBeastTamed(e.beastId, e.nameKey);
  }
  if (e.type === "bondFailed") {
    bus.emit({ type: "toast", text: t("toast.bondFailed", { beast: t(e.nameKey) }) });
  }
});
hud.setShards(shards());

const FETCH_RADIUS = 16; // how far from the player a drop may be to be offered
const FETCH_SCAN = 0.4; // seconds between scans; the pool is small but this is a poll
let fetchScanT = 0;

function worthFetching(itemId: string): boolean {
  const def = itemDef(itemId);
  // STACKABLE, not "anything you already hold" — issue #74 split those, and a beast that fetched back the blueprint you just dropped is an errand nobody asked for.
  return def.kind === "currency" || (def.kind === "stackable" && bag.count(itemId) > 0);
}

// INVENTORY, GEAR AND ITEM ACTIONS — issue #74. The panel knows no game rules: it is handed rows and
// reports a button, so every rule is here. The two BEAST slots ARE `primaryIdx`/`supportIdx`, the
// numbers Tab moves, so the panel and the world keys can never disagree.

// Read off `Player` once at boot so the two cannot drift; `Player.reset()` leaves `attackStat` alone, so `applyLoadout()` restores it.
const BASE_ATTACK = player.attackStat;

/** The weapon in the gear slot, by item id, or null for bare hands. */
let equippedWeapon: string | null = null;

// The taming orb `Q` would throw.
let readiedOrb: string | null = null;

// Called where the pair CHANGES — readied, unreadied, thrown, reset — and never per frame: the HUD holds the rendered chip and only redraws on change.
function refreshOrbHud(): void {
  const def = readiedOrb ? itemDef(readiedOrb) : null;
  const n = readiedOrb ? bag.count(readiedOrb) : 0;
  hud.setOrb(
    def && n > 0
      ? { name: itemName(def, n), count: n, color: def.color, tier: def.orbTier ?? 1 }
      : null,
  );
}
/** A potion's timed buff: how much attack it is adding, and for how much longer. */
let attackBuff = 0;
let attackBuffT = 0;

function applyLoadout(): void {
  const w = equippedWeapon ? itemDef(equippedWeapon) : null;
  player.attackStat = BASE_ATTACK + (w?.power ?? 0) + attackBuff;
  // What he is HOLDING: `ItemDef.model` names a voxel model, and null is bare hands, which
  // switches the animator to the punch table. The rig is the storage, so there is no second field.
  player.setWeapon(weaponModelOf(w));
  // The panel's own hero rig has to be told too; it may be shut and will draw with this next time.
  inventory.setHeroWeapon(w?.model ?? null);
}

function weaponModelOf(def: ItemDef | null): WeaponModelId | null {
  const m = def?.model;
  return m && (WEAPON_MODEL_IDS as readonly string[]).includes(m) ? (m as WeaponModelId) : null;
}

// The smallest kit that shows every kind of row the panel draws except the content-only quest one.
// ONE TAME ORB, READIED, because the player starts with no beasts and the only way to get one is a
// throw — enough for one Sproutle and not enough to be a supply.
function giveStartingKit(): void {
  bag.add("sword-iron", 1);
  bag.add("potion-mend", 2);
  bag.add("bp-dagger", 1);
  bag.add("orb-tame", 1);
  equippedWeapon = "sword-iron";
  readiedOrb = "orb-tame";
  applyLoadout();
  refreshBagChips();
  refreshOrbHud();
}

// A `function` so the registration hundreds of lines above can name it. Currency folds into the pickup total rather than being refused.
function giveItemFromContent(id: string, n: number): void {
  const def = itemDef(id);
  if (def.kind === "currency") {
    pickupTotal += n;
    hud.setShards(shards());
  } else {
    bag.add(id, n);
    refreshBagChips();
  }
  bus.emit({ type: "toast", text: t("toast.gotItem", { item: itemName(def, n) }) });
  // The panel is a modal, but the dev console can reach here, and so could timed content.
  inventory.refresh();
}

/** A beast's inventory id. The panel round-trips it; nothing else parses it. */
const beastItemId = (b: BeastActor): string => BEAST_ID_PREFIX + b.id;

/** One display stat pair, so the builders below all read the same way. */
const invStat = (label: StringKey, value: string | number): InvStat => ({
  label: t(label),
  value: String(value),
});

// Derived every time — on open and after each action, never inside a frame — because the bag and the roster are the truth and a cached view of them is a second answer.
function inventoryModel(): InventoryModel {
  const entries: InvEntry[] = [];

  for (const b of ownedBeasts()) {
    const lead = b === primary();
    const supporting = b === support();
    entries.push({
      id: beastItemId(b),
      kind: "beast",
      name: t(b.species.nameKey),
      count: 1,
      color: ELEMENT_COLORS[b.species.element],
      // The SPECIES, not a copy off it: the panel's stage builds its own rig and bakes the slot portrait from this (see ui/inventory-stage.ts).
      species: b.species,
      rarity: "rare",
      description: t(b.species.descriptionKey),
      equipped: lead || supporting,
      stats: [
        invStat("inv.stat.level", b.level),
        invStat("inv.stat.movement", t(LOCOMOTION_NAME_KEYS[b.species.locomotion])),
        {
          label: t("inv.gear"),
          value: t(
            lead ? "inv.beast.lead" : supporting ? "inv.beast.support" : "inv.beast.benched",
          ),
        },
      ],
      // A beast is never dropped or salvaged; its actions are the slots it can move into, and it can come OUT of one (issue #116).
      actions: lead
        ? ["setSupport", "unequip"]
        : supporting
          ? ["setLead", "unequip"]
          : ["setLead", "setSupport"],
    });
  }

  for (const e of bag.entries()) {
    const d = e.def;
    const stats: InvStat[] = [];
    if (d.power !== undefined) {
      stats.push(invStat("inv.stat.power", "+" + d.power));
    }
    if (d.maxPower !== undefined) {
      stats.push(invStat("inv.stat.budget", d.maxPower));
    }
    if (d.effect?.heal !== undefined) {
      stats.push(invStat("inv.stat.heal", d.effect.heal));
    }
    if (d.effect?.attack !== undefined) {
      stats.push(
        invStat("inv.stat.attack", "+" + d.effect.attack + " · " + (d.effect.seconds ?? 0) + "s"),
      );
    }
    const worth = salvageValue(d);
    if (worth > 0) {
      stats.push(invStat("inv.stat.salvage", worth));
    }
    if (e.count > 1) {
      stats.push(invStat("inv.stat.held", e.count));
    }

    if (d.orbTier !== undefined) {
      stats.push(invStat("inv.stat.orbTier", d.orbTier));
    }

    const actions: InvAction[] = [];
    const equipped =
      d.kind === "weapon"
        ? d.id === equippedWeapon
        : d.kind === "orb"
          ? d.id === readiedOrb
          : false;
    if (d.kind === "weapon") {
      actions.push(equipped ? "unequip" : "equip");
    }
    if (d.kind === "orb") {
      actions.push(equipped ? "unready" : "ready");
    }
    if (d.kind === "potion") {
      actions.push("use");
    }
    if (d.kind === "blueprint") {
      actions.push("forge");
    }
    // An EQUIPPED weapon offers neither destructive action; unequip is one click away.
    if (worth > 0 && !equipped) {
      actions.push("salvage");
    }
    if (isDestructible(d) && !equipped) {
      actions.push("drop");
    }

    entries.push({
      id: d.id,
      kind: d.kind,
      name: itemName(d, e.count),
      count: e.count,
      color: d.color,
      icon: d.icon,
      orbTier: d.orbTier,
      rarity: d.rarity,
      description: d.descriptionKey ? t(d.descriptionKey) : undefined,
      stats,
      equipped,
      note:
        d.kind === "blueprint"
          ? t("inv.forge.soon")
          : d.kind === "quest"
            ? t("inv.quest.kept")
            : d.kind === "orb" && equipped
              ? t("inv.orb.hint", { key: kbd("Q") })
              : undefined,
      actions,
    });
  }

  const byId = (id: string | null): InvEntry | null =>
    id === null ? null : (entries.find((x) => x.id === id) ?? null);
  const slotFor = (b: BeastActor | null): InvEntry | null =>
    b === null ? null : byId(beastItemId(b));

  const gear: GearSlotView[] = [
    { slot: "weapon", entry: byId(equippedWeapon) },
    { slot: "primary", entry: slotFor(primary()) },
    { slot: "support", entry: slotFor(support()) },
    { slot: "orb", entry: byId(readiedOrb) },
  ];

  // A GEAR SLOT IS A REAL SLOT: what is in it is not also on the wall, or the count lies.
  const claimed = new Set(gear.map((g) => g.entry?.id).filter((id): id is string => !!id));
  const wall: InvEntry[] = [];
  for (const e of entries) {
    if (!claimed.has(e.id)) {
      wall.push(e);
      continue;
    }
    const left = e.count - 1;
    if (left <= 0) {
      continue;
    }
    wall.push({ ...e, count: left, name: itemName(itemDef(e.id), left) });
  }

  // Where each row sits (issue #116): the order above only picks which free cell a new row gets, then the layout answers.
  slots.reconcile(wall.map((e) => e.id));
  for (const e of wall) {
    e.slot = slots.slotOf(e.id);
  }
  wall.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  // All three, always, unlocked or not — the one thing this panel shows that the player does not have.
  const mounts = MOUNT_KINDS.map((kind) => ({ kind, unlocked: mountUnlocks.has(kind) }));

  return { gear, entries: wall, mounts };
}

// A button on a row; every rule the panel does not know lives in this switch.
function inventoryAction(id: string, action: InvAction): void {
  if (id.startsWith(BEAST_ID_PREFIX)) {
    const beastId = id.slice(BEAST_ID_PREFIX.length);
    const idx = roster.findIndex((b) => b.id === beastId);
    // Refused here as well as being absent from the model: `__dbgInvAction` bypasses the panel.
    if (idx < 0 || !owned.has(beastId)) {
      return;
    }
    // Straight onto the two indices Tab moves: putting a beast into one slot pushes whoever was there into the other rather than benching them.
    if (action === "setLead") {
      if (supportIdx === idx) {
        supportIdx = primaryIdx;
      }
      primaryIdx = idx;
    } else if (action === "setSupport") {
      if (primaryIdx === idx) {
        primaryIdx = supportIdx;
      }
      supportIdx = idx;
    } else if (action === "unequip") {
      // Out of whichever slot it is in, and nothing slides up: emptying the lead slot must not change the support beast's job.
      if (primaryIdx === idx) {
        primaryIdx = -1;
      } else if (supportIdx === idx) {
        supportIdx = -1;
      } else {
        return;
      }
    } else {
      return;
    }
    refreshVisibility();
    const lead = primary();
    const sup = support();
    bus.emit({
      type: "toast",
      text: t("toast.beastLeads", {
        lead: lead ? t(lead.species.nameKey) : t("beast.none"),
        support: sup ? t(sup.species.nameKey) : t("beast.none"),
      }),
    });
    return;
  }

  const def = itemDef(id);
  if (!isKnownItem(id) || bag.count(id) <= 0) {
    return;
  }

  switch (action) {
    case "equip":
      if (def.kind !== "weapon") {
        return;
      }
      equippedWeapon = def.id;
      applyLoadout();
      bus.emit({ type: "toast", text: t("toast.equipped", { item: itemName(def) }) });
      break;

    case "unequip":
      if (equippedWeapon !== def.id) {
        return;
      }
      equippedWeapon = null;
      applyLoadout();
      bus.emit({ type: "toast", text: t("toast.unequipped", { item: itemName(def) }) });
      break;

    // READYING IS NOT EQUIPPING: nothing is held and no stat moved, so `applyLoadout` is not called.
    case "ready":
      if (def.kind !== "orb") {
        return;
      }
      readiedOrb = def.id;
      refreshOrbHud();
      bus.emit({ type: "toast", text: t("toast.orbReady", { item: itemName(def) }) });
      break;

    case "unready":
      if (readiedOrb !== def.id) {
        return;
      }
      readiedOrb = null;
      refreshOrbHud();
      bus.emit({ type: "toast", text: t("toast.unequipped", { item: itemName(def) }) });
      break;

    case "use": {
      const fx = def.effect;
      if (!fx || bag.remove(def.id, 1) !== 1) {
        return;
      }
      if (fx.heal) {
        player.heal(fx.heal);
      }
      if (fx.attack) {
        // A second draught REPLACES the timer rather than stacking onto it — stacking is a balance decision, and this cannot compound into a stat nobody has tuned.
        attackBuff = fx.attack;
        attackBuffT = fx.seconds ?? 0;
      }
      applyLoadout();
      refreshBagChips();
      bus.emit({ type: "toast", text: t("toast.used", { item: itemName(def) }) });
      break;
    }

    case "salvage": {
      const worth = salvageValue(def);
      // Paid off what actually LEFT the bag, not off the request.
      if (worth <= 0 || bag.remove(def.id, 1) !== 1) {
        return;
      }
      spent -= worth;
      hud.setShards(shards());
      refreshBagChips();
      bus.emit({
        type: "toast",
        text: t("toast.salvaged", {
          item: itemName(def),
          n: worth,
          currency: itemName(CURRENCY, worth),
        }),
      });
      break;
    }

    case "drop": {
      if (!isDestructible(def) || bag.remove(def.id, 1) !== 1) {
        return;
      }
      // UNARMED (see Pickups.spawn): armed it would magnet straight back into the bag it just left.
      combat.spawnDrop(
        def.id,
        player.position.x,
        player.position.y + 0.6,
        player.position.z,
        false,
      );
      refreshBagChips();
      bus.emit({ type: "toast", text: t("toast.dropped", { item: itemName(def) }) });
      break;
    }

    case "forge":
      bus.emit({ type: "toast", text: t("inv.forge.soon") });
      break;

    default:
      break;
  }
}

function updateBuffs(dt: number): void {
  if (attackBuffT <= 0) {
    return;
  }
  attackBuffT -= dt;
  if (attackBuffT > 0) {
    return;
  }
  attackBuffT = 0;
  attackBuff = 0;
  applyLoadout();
  bus.emit({ type: "toast", text: t("toast.buffEnded") });
}

const inventory = new InventoryPanel({
  model: inventoryModel,
  onAction: inventoryAction,
  // A MOVED BOX IS NOT A GAME RULE — the layout is the whole of the state it touches, which is why it is not an `InvAction`.
  onMove: (id, slot) => slots.move(id, slot),
  // A panel you CLICK, so the cursor has to reach it. The F1 sheet is read, and keeps its lock.
  onOpen: () => input.releaseLock(),
  // Safe after a click or `I`, not after Escape: with no keyboard lock that press also leaves fullscreen,
  // dropping the pointer lock ~8 ms later, which read as a fresh Escape and opened the menu behind it.
  onClose: (by) => {
    if (isTouchPrimary()) {
      return;
    }
    if (by !== "escape" || escapeIsLocked()) {
      input.requestLock();
    }
  },
});

giveStartingKit();

// The quest journal — issue #98.
const hudFlag = (id: ContentId): string => `journal.hidden/${id}`;
const questOnHud = (id: ContentId): boolean => !content.state.flag(hudFlag(id));

function rewardLines(rewards: QuestRewards | undefined): { label: string; value: string }[] {
  if (!rewards) {
    return [];
  }
  return Object.entries(rewards).map(([key, n]) => ({
    label:
      key === "xp" ? t("journal.reward.xp") : isKnownItem(key) ? itemName(itemDef(key), n) : key,
    value: String(n),
  }));
}

// `available` is DERIVED — untouched, prerequisites done, own condition passes — rather than a fourth stored copy. A failed quest shows under "done".
function questTab(asset: ContentAsset<QuestData>): JournalTab | null {
  switch (content.state.questStatus(asset.id)) {
    case "active":
      return "active";
    case "completed":
    case "failed":
      return "completed";
    case "available":
      return "available";
    default:
      break;
  }
  const ready = asset.data.prerequisites.every(
    (id) => content.state.questStatus(id) === "completed",
  );
  return ready && content.evaluate(asset.data.available) ? "available" : null;
}

// HOVER PREVIEWS IN QUEST PROSE (issue #246). The hoverable names are derived
// from the quest's STRUCTURED trigger — never matched out of the prose — so a
// translation keeps its hovers: the trigger names ids, each id resolves to the
// display name the same language table wrote into the line, and the journal
// wraps that name where the line contains it. Prose that names nothing
// structured gets no hover, which is correct.

/** The staged sites a trigger can name (`QUEST_SITE_NAMES`), as display text. */
const SITE_TIP_KEYS: Record<string, { name: StringKey; desc: StringKey }> = {
  "vane-wreck": { name: "site.vaneWreck.name", desc: "site.vaneWreck.desc" },
  "maws-rest": { name: "site.mawsRest.name", desc: "site.mawsRest.desc" },
  "drove-ground": { name: "site.droveGround.name", desc: "site.droveGround.desc" },
  "hold-floor": { name: "site.holdFloor.name", desc: "site.holdFloor.desc" },
};

const speciesById = (id: string): BeastSpecies | undefined =>
  ALL_SPECIES.find((sp) => sp.id === id);

/** The beast species whose body an enemy wears, or undefined for a monster's own. */
function enemyBeast(spec: EnemySpec): BeastSpecies | undefined {
  return ALL_SPECIES.find((sp) => spec.data.model === `beast-${sp.id}`);
}

function questHovers(trigger: ObjectiveTrigger | undefined): JournalHover[] {
  if (!trigger) {
    return [];
  }
  const out: JournalHover[] = [];
  // A trigger's species list can name a BEAST ("sproutle") or a WILD population
  // ("wild-sproutle", an enemy species id) — both are previews of an animal.
  for (const sid of trigger.species ?? []) {
    const sp = speciesById(sid);
    if (sp) {
      out.push({ name: t(sp.nameKey), tip: `beast:${sp.id}` });
      continue;
    }
    const spec = enemySpecies().find((s) => s.id === sid);
    if (spec) {
      out.push({ name: t(spec.nameKey), tip: `enemy:${spec.id}` });
    }
  }
  for (const eid of trigger.enemies ?? []) {
    const spec = enemySpecies().find((s) => `enemy:${s.id}` === eid);
    if (spec) {
      out.push({ name: t(spec.nameKey), tip: `enemy:${spec.id}` });
    }
  }
  if (trigger.item !== undefined && isKnownItem(trigger.item)) {
    out.push({ name: itemName(itemDef(trigger.item), 1), tip: `item:${trigger.item}` });
  }
  if (trigger.site !== undefined && SITE_TIP_KEYS[trigger.site]) {
    out.push({ name: t(SITE_TIP_KEYS[trigger.site].name), tip: `site:${trigger.site}` });
  }
  return out;
}

/** `<i class="ic beast">` for the tip: the baked portrait, or the blob until it lands. */
function beastTipIcon(sp: BeastSpecies): string {
  return entryIconHtml({
    color: ELEMENT_COLORS[sp.element],
    speciesId: sp.id,
    iconUrl: inventory.beastIcon(sp),
  });
}

/** What a hovered name shows. Ids are namespaced by `questHovers` above. */
function journalTipFor(id: string): TipContent | null {
  if (id.startsWith("beast:")) {
    const sp = speciesById(id.slice("beast:".length));
    return sp
      ? {
          name: t(sp.nameKey),
          color: ELEMENT_COLORS[sp.element],
          description: t(sp.descriptionKey),
          iconHtml: beastTipIcon(sp),
        }
      : null;
  }
  if (id.startsWith("enemy:")) {
    const spec = enemySpecies().find((s) => `enemy:${s.id}` === id);
    if (!spec) {
      return null;
    }
    // A wild body that IS a beast body shows that beast's portrait and nature.
    const sp = enemyBeast(spec);
    return {
      name: t(spec.nameKey),
      color: sp ? ELEMENT_COLORS[sp.element] : 0xff5d5d,
      description: sp ? t(sp.descriptionKey) : undefined,
      ...(sp ? { iconHtml: beastTipIcon(sp) } : {}),
    };
  }
  if (id.startsWith("item:")) {
    const itemId = id.slice("item:".length);
    if (!isKnownItem(itemId)) {
      return null;
    }
    const def = itemDef(itemId);
    return {
      name: itemName(def, 1),
      color: def.color,
      rarity: def.rarity,
      description: def.descriptionKey ? t(def.descriptionKey) : undefined,
      iconHtml: entryIconHtml({
        color: def.color,
        kind: def.kind,
        icon: def.icon,
        orbTier: def.orbTier,
      }),
    };
  }
  if (id.startsWith("site:")) {
    const keys = SITE_TIP_KEYS[id.slice("site:".length)];
    return keys ? { name: t(keys.name), color: 0xffc44d, description: t(keys.desc) } : null;
  }
  return null;
}

// `query.available` rather than `all`: the asset envelope's `when` is how content hides something entirely, and
// a journal listing it would be the one place that leaked it.
function journalModel(): JournalModel {
  const entries: JournalEntry[] = [];
  for (const asset of content.query.available<QuestData>("quest")) {
    const tab = questTab(asset);
    if (tab === null) {
      continue;
    }
    const giver = asset.data.giver ? content.get(asset.data.giver) : undefined;
    const place = asset.data.location ? content.get(asset.data.location) : undefined;
    entries.push({
      id: asset.id,
      name: resolveText(asset.name, `[${asset.id}]`),
      description: hasText(asset.description) ? resolveText(asset.description) : undefined,
      category: asset.data.category,
      tab,
      arc: asset.data.arc,
      giver: giver && hasText(giver.name) ? resolveText(giver.name) : undefined,
      location: place && hasText(place.name) ? resolveText(place.name) : undefined,
      objectives: asset.data.objectives.map((o) => ({
        text: resolveText(o.text, o.key),
        have: content.state.progress(asset.id, o.key),
        need: o.count ?? 1,
        hovers: questHovers(o.trigger),
      })),
      rewards: rewardLines(asset.data.rewards),
      onHud: questOnHud(asset.id),
    });
  }
  // Main before side, then by id — the same total order every read, so a card does not move when a counter ticks.
  entries.sort(
    (a, b) =>
      (a.category === b.category ? 0 : a.category === "main" ? -1 : 1) || a.id.localeCompare(b.id),
  );
  return { entries };
}

/** The tracker's rows: the ACTIVE quests the player has left switched on. */
function questTrackRows(): QuestTrackRow[] {
  return journalModel()
    .entries.filter((e) => e.tab === "active" && e.onHud)
    .map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      steps: e.objectives.map((o) => ({ text: o.text, have: o.have, need: o.need })),
    }));
}

const journal = new JournalPanel({
  model: journalModel,
  onToggleHud: (id) => {
    content.state.setFlag(hudFlag(id), questOnHud(id));
  },
  tipFor: journalTipFor,
  // The inventory's bargain: a panel with buttons needs a cursor, and re-taking the lock after Escape is what makes one press close two things.
  onOpen: () => input.releaseLock(),
  onClose: (by) => {
    if (isTouchPrimary()) {
      return;
    }
    if (by !== "escape" || escapeIsLocked()) {
      input.requestLock();
    }
  },
});
// A portrait that finishes baking while a journal tip is up lands in it (issue #246).
inventory.onPortrait = (id, url) => journal.patchPortrait(id, url);

// THE WORLD MAP (issue #245), and the one marker the player may plant on it.
// The marker is session state under issue #171's rule — reset in exitToTitle,
// saved, loaded — and carries its ZONE: a flag planted on the overworld must
// not point at a spot inside the Hold, so the chip and the map only show it in
// the zone it was planted in, and a save naming a zone this build no longer
// has drops the flag rather than the load.
let playerMarker: { zone: string; x: number; z: number } | null = null;
const MARKER_CHIP_ID = "player-marker";
/** Where he has walked, per zone — the map's fog of war lifts over it. Same lifecycle as the flag. */
const exploration = new Exploration();

function syncMarkerChip(): void {
  if (playerMarker && playerMarker.zone === zones.id) {
    hud.addCompassMarker({
      id: MARKER_CHIP_ID,
      x: playerMarker.x,
      z: playerMarker.z,
      // The waystone crystal's cyan — the player's own things share a colour.
      color: 0x8be3ff,
      icon: FLAG_ICON,
    });
  } else {
    hud.removeCompassMarker(MARKER_CHIP_ID);
  }
}

function setPlayerMarker(spot: { x: number; z: number } | null): void {
  playerMarker = spot ? { zone: zones.id, x: spot.x, z: spot.z } : null;
  syncMarkerChip();
}

/**
 * What the map paints its base image from. The world has no bounds — it grows
 * from its seed as far as anyone walks — so this hands over samplers, not a
 * rectangle. Roads are re-read when the network has grown (memoised on count).
 */
function mapTerrain(): MapTerrain {
  let roadsOf: typeof world.towns.roads | null = null;
  let roads: Array<Array<readonly [number, number]>> = [];
  return {
    zoneId: zones.id,
    heightAt: (x, z) => world.getHeight(x, z),
    waterLevel: world.waterLevel,
    explored: () => exploration.cells(zones.id),
    roads: () => {
      if (roadsOf !== world.towns.roads || roads.length !== world.towns.roads.length) {
        roadsOf = world.towns.roads;
        roads = world.towns.roads.map((r) => {
          const line: Array<readonly [number, number]> = [];
          for (let i = 0; i < r.path.length; i += 3) {
            line.push([r.path[i], r.path[i + 2]]);
          }
          return line;
        });
      }
      return roads;
    },
  };
}

const map = new MapPanel({
  model: () => {
    const quests = questSpots();
    return {
      towns: world.towns.all.map((town) => ({
        id: town.id,
        name: t(town.nameKey),
        color: town.color,
        x: town.x,
        z: town.z,
        kind: town.kind,
        // A town is on the map once he has SEEN it, or a quest has sent him there
        // (its spot lies within the town): the world map is not spoiled by data.
        known:
          exploration.revealed(zones.id, town.x, town.z) ||
          quests.some((s) => Math.hypot(s.x - town.x, s.z - town.z) <= town.outerRadius),
      })),
      stones: (world.waypoints?.all ?? []).map((w) => ({
        id: w.id,
        x: w.x,
        z: w.z,
        lit: waypointLit(w.id),
      })),
      quests,
      player: { x: player.position.x, z: player.position.z, facing: player.facing },
      marker:
        playerMarker && playerMarker.zone === zones.id
          ? { x: playerMarker.x, z: playerMarker.z }
          : null,
    };
  },
  zoneId: () => zones.id,
  terrain: mapTerrain,
  onTravel: (stoneId) => {
    const stone = world.waypoints?.all.find((w) => w.id === stoneId);
    // Lit is re-checked at the moment of travel — the panel's list is a frame old.
    if (!stone || !waypointLit(stone.id)) {
      return;
    }
    map.close("travel");
    teleportTo(stone.x, stone.z);
  },
  onMarker: (spot) => {
    setPlayerMarker(spot);
    if (spot) {
      bus.emit({ type: "toast", text: t("toast.markerPlaced") });
    }
  },
  onOpen: () => input.releaseLock(),
  onClose: (by) => {
    if (isTouchPrimary()) {
      return;
    }
    if (by !== "escape" || escapeIsLocked()) {
      input.requestLock();
    }
  },
});

// Quest marks over the world (PR feedback on #181), recomputed from quest facts rather than pushed.
// Keyed the way the WORLD keys — `gain` not `npc:gain`, `sproutle` not `wild-sproutle` — so the frame
// loop is two lookups.
const markedNpcs = new Map<string, QuestMarkerKind>();
const markedEnemies = new Set<string>();
const markedBeasts = new Set<string>();

/** Every objective met — the quest is ready to hand in, but is not handed in. */
function questIsDone(asset: ContentAsset<QuestData>): boolean {
  return asset.data.objectives.every(
    (o) => content.state.progress(asset.id, o.key) >= (o.count ?? 1),
  );
}

function refreshQuestMarks(): void {
  markedNpcs.clear();
  markedEnemies.clear();
  markedBeasts.clear();
  for (const asset of content.query.available<QuestData>("quest")) {
    const tab = questTab(asset);
    if (tab !== "available" && tab !== "active") {
      continue;
    }
    // Who to walk to, and it is two people when a quest ends where it sent you: the offer mark is the
    // giver's, the turn-in mark the closer's, and `turnIn` absent means the one person holds both.
    const walkTo = tab === "available" ? asset.data.giver : (asset.data.turnIn ?? asset.data.giver);
    // TURN-IN BEATS OFFER when one person holds both: the quest in your hand is the live one.
    if (walkTo !== undefined && walkTo !== "") {
      const who = walkTo.slice("npc:".length);
      if (tab === "available") {
        if (!markedNpcs.has(who)) {
          markedNpcs.set(who, "offer");
        }
      } else if (questIsDone(asset)) {
        markedNpcs.set(who, "turnIn");
      }
    }
    if (tab !== "active") {
      continue;
    }
    for (const objective of asset.data.objectives) {
      const trigger = objective.trigger;
      if (!trigger) {
        continue;
      }
      if (content.state.progress(asset.id, objective.key) >= (objective.count ?? 1)) {
        continue;
      }
      for (const id of trigger.enemies ?? []) {
        markedEnemies.add(id.slice("enemy:".length));
      }
      for (const id of trigger.species ?? []) {
        // BOTH SETS: a species filter may name a wild instance (`wild-sproutle`,
        // the tamed fact's id) or a companion (`sproutle`, what a beast-bodied
        // enemy resolves to), and the ring must find it either way.
        markedBeasts.add(id);
        markedEnemies.add(id);
      }
      // The ESCORTED character wears the target ring — the same "this is the
      // thing the quest is counting" mark, over a person, following him as he
      // walks because `syncQuestMarks` reads his live published position.
      if (trigger.npc !== undefined && trigger.npc !== "") {
        const who = trigger.npc.slice("npc:".length);
        if (!markedNpcs.has(who)) {
          markedNpcs.set(who, "target");
        }
      }
    }
  }
}

/** Marker heights: over the head, not on it. A hero is 1.8 units tall. */
const NPC_MARK_RISE = 2.5;
const ENEMY_MARK_RISE = 0.75;

const questMarkers = new QuestMarkers(engine.scene);
/** Scratch, refilled each frame — see the pooling note in world/quest-markers.ts. */
const questMarkSpots: QuestMarkerSpot[] = [];
let questMarkCount = 0;

function markSpot(x: number, y: number, z: number, kind: QuestMarkerKind): void {
  const spot = questMarkSpots[questMarkCount];
  if (spot) {
    spot.x = x;
    spot.y = y;
    spot.z = z;
    spot.kind = kind;
  } else {
    questMarkSpots.push({ x, y, z, kind });
  }
  questMarkCount++;
}

// Per FRAME rather than per slice: a mark is presentation, culled against the camera this frame placed, and an NPC's published position is already this frame's.
function syncQuestMarks(dt: number): void {
  questMarkCount = 0;
  if (markedNpcs.size > 0) {
    for (const n of world.npcs?.all ?? []) {
      const kind = markedNpcs.get(n.id);
      if (kind) {
        markSpot(n.x, n.y + NPC_MARK_RISE, n.z, kind);
      }
    }
  }
  if (markedEnemies.size > 0 || markedBeasts.size > 0) {
    for (const e of combat.enemies) {
      if (!e.targetable) {
        continue;
      }
      const bond = markedBeasts.size > 0 ? combat.bondSpeciesOf(e) : null;
      if (!markedEnemies.has(e.species) && !(bond && markedBeasts.has(bond))) {
        continue;
      }
      markSpot(e.position.x, e.position.y + e.height + ENEMY_MARK_RISE, e.position.z, "target");
    }
  }
  questMarkers.update(dt);
  questMarkers.set(questMarkSpots, questMarkCount, engine.camera);
}

// Subscribed to CONTENT rather than pushed from each place a quest changes: `onChange` already fires for all of them.
/**
 * WHERE AN ACTIVE QUEST WANTS YOU — one compass chip per tracked quest.
 *
 * A quest names places the player has never been ("the Sunken Hold"), and a name
 * is not a direction. The chip is derived from the same objectives the journal
 * lists, in the order the player would meet them:
 *
 *   1. the first UNMET objective that names a place — a town's gate, or the
 *      gateway out of this zone for one that names another zone;
 *   2. failing that, whoever CLOSES it, because a quest with nothing left to do
 *      is a walk back to a person;
 *   3. failing that, the quest's own `location`.
 *
 * Nothing here knows a quest by name, and a quest that names no place gets no
 * chip rather than a chip pointing at the middle of the world.
 */
function questSpots(): Array<{ id: string; name: string; x: number; z: number }> {
  const out: Array<{ id: string; name: string; x: number; z: number }> = [];
  for (const row of questTrackRows()) {
    const asset = content.get<QuestData>(row.id);
    if (!asset) {
      continue;
    }
    const spot = questWaypoint(asset);
    if (!spot) {
      continue;
    }
    // The asset id IS the spot id: it already carries its `quest:` namespace, and
    // a second one only makes `quest:quest:land/…`.
    out.push({ id: asset.id, name: row.name, x: spot.x, z: spot.z });
  }
  return out;
}

function questCompassSpots(): CompassMarker[] {
  return questSpots().map((s) => ({
    id: s.id,
    x: s.x,
    z: s.z,
    // The gold the world marks and the map's star are drawn in, and the SAME
    // star (issue #252): a chip on the rim, a star on the map, one meaning.
    color: 0xffc44d,
    icon: QUEST_STAR_ICON,
  }));
}

/** The one place `questCompassSpots` sends you for this quest, or null. */
function questWaypoint(asset: ContentAsset<QuestData>): { x: number; z: number } | null {
  // A LANDMARK OBJECTIVE HAS NO TRIGGER TO POINT WITH: the reef ring is not a
  // town, so the closer's waypoint is named here, in the file that owns the
  // site. The first landmark quest earns the special case; a second one buys a
  // `site` field on the trigger instead of a third branch.
  if (
    asset.id === "quest:sea/what-the-tide-kept" &&
    content.state.progress(asset.id, "reach-maws-rest") < 1
  ) {
    const ring = mawsRest();
    if (ring) {
      return { x: ring.x, z: ring.z };
    }
  }
  for (const objective of asset.data.objectives) {
    if (content.state.progress(asset.id, objective.key) >= (objective.count ?? 1)) {
      continue;
    }
    const trigger = objective.trigger;
    if (!trigger) {
      continue;
    }
    // A staged site is a PLACE the same way a town is — the escort's compass
    // chip points at the destination for as long as the walk is owed.
    if (trigger.site !== undefined) {
      const s = questSite(trigger.site);
      if (s) {
        return { x: s.x, z: s.z };
      }
    }
    if (trigger.town !== undefined && trigger.town !== "") {
      const town = world.towns.get(trigger.town.slice("town:".length));
      if (town) {
        return { x: town.gateX, z: town.gateZ };
      }
    }
    // ANOTHER ZONE IS A DOOR, not a place: the only thing this world can point
    // at is the way out of it — the arch for THAT zone, where there is one.
    if (trigger.zone !== undefined && trigger.zone !== zones.id) {
      const g = zones.gatewayTo(trigger.zone);
      return { x: g.x, z: g.z };
    }
  }
  const closer = asset.data.turnIn ?? asset.data.giver;
  const who = closer ? world.npcs?.all.find((n) => `npc:${n.id}` === closer) : undefined;
  if (who) {
    return { x: who.x, z: who.z };
  }
  const home = asset.data.location;
  const town = home ? world.towns.get(home.slice("town:".length)) : undefined;
  return town ? { x: town.gateX, z: town.gateZ } : null;
}

/** Chips currently drawn for quests, so a completed one's chip is removed and not left on the rim. */
let questChipIds: string[] = [];

function refreshQuestChips(): void {
  const spots = questCompassSpots();
  for (const id of questChipIds) {
    if (!spots.some((s) => s.id === id)) {
      hud.removeCompassMarker(id);
    }
  }
  for (const spot of spots) {
    hud.addCompassMarker(spot);
  }
  questChipIds = spots.map((s) => s.id);
}

const refreshQuests = (): void => {
  hud.setQuests(questTrackRows());
  journal.refresh();
  // The marks are the same fact drawn in the world, so the same subscriber recomputes them.
  refreshQuestMarks();
  // And the same fact on the compass rim: where the quest wants you, in a direction.
  refreshQuestChips();
};
content.state.onChange((change) => {
  // `flag` is in here because the HUD switch IS a flag — see `hudFlag`.
  if (change.kind !== "discovery") {
    refreshQuests();
  }
  // A DISCOVERY IS WHAT LIGHTS A STONE, so a load, a reset and a walk up to one
  // all reach the same redraw. `setLit` is idempotent and compares before it writes.
  if (change.kind === "discovery" || change.kind === "reset") {
    world.waypoints?.setLit(waypointLit);
  }
});
content.onDefinitionsChange(refreshQuests);
refreshQuests();

// What makes a quest MOVE — game-story.md §7, issue #143. `id` is whatever the kind identifies, absent for a kind that identifies nothing.
interface QuestFact {
  readonly kind: ObjectiveTriggerKind;
  readonly id?: string;
}

// ONE ROUTER, NOT A HOOK PER QUEST: an objective declares WHICH fact it counts, so adding a KIND is
// engine work and a quest that uses one is data. ACTIVE quests only. It never runs `quest.complete` —
// meeting the counts makes a quest turn-INNABLE, and the giver's dialogue closes it.
function advanceObjectives(fact: QuestFact): void {
  for (const questId of content.state.activeQuests) {
    const asset = content.get<QuestData>(questId);
    if (!asset) {
      continue;
    }
    for (const objective of asset.data.objectives) {
      const trigger = objective.trigger;
      if (!trigger || trigger.kind !== fact.kind) {
        continue;
      }
      // Each filter constrains its own kind only; absent is "any", and present-and-unmatched refuses, so a widened event that forgets its id under-counts.
      if (
        fact.kind === "enemy-killed" &&
        trigger.enemies &&
        !trigger.enemies.includes(fact.id ?? "")
      ) {
        continue;
      }
      if (fact.kind === "tamed" && trigger.species && !trigger.species.includes(fact.id ?? "")) {
        continue;
      }
      if (fact.kind === "item-picked" && trigger.item !== undefined && trigger.item !== fact.id) {
        continue;
      }
      if (fact.kind === "town-arrival" && trigger.town !== undefined && trigger.town !== fact.id) {
        continue;
      }
      if (fact.kind === "zone-arrival" && trigger.zone !== undefined && trigger.zone !== fact.id) {
        continue;
      }
      if (fact.kind === "escort" && trigger.npc !== undefined && trigger.npc !== fact.id) {
        continue;
      }
      // `zone` ON ANY OTHER KIND IS WHERE IT HAPPENED, not what it identifies — the one filter that is
      // about the fact's PLACE rather than its subject. It is what separates "bond a beast" (quest 2,
      // true anywhere) from "free the one held down in the Hold" (quest 4) with no second trigger kind.
      if (fact.kind !== "zone-arrival" && trigger.zone !== undefined && trigger.zone !== zones.id) {
        continue;
      }
      const have = content.state.progress(questId, objective.key);
      if (have < (objective.count ?? 1)) {
        content.state.setProgress(questId, objective.key, have + 1);
      }
    }
  }
}

/**
 * TOUCHING DARK WATER MOUNTS THE WATER BEAST (issue #153) — an engine mechanic,
 * not a quest step: gated on the story flag and the unlock, so it keeps working
 * after Dark Water is turned in and in every later act. The beast surfaces to
 * carry him: a benched water companion is brought out as the lead first, which
 * is the same slot-visibility rule Tab uses.
 */
function tryAutoMountWater(): void {
  if (!playing || mount.isMounted || sail !== null) {
    return;
  }
  if (!mountUnlocks.has("water") || !content.state.flag("mount-water")) {
    return;
  }
  const water = ownedBeasts().filter(
    (b) => MOUNT_KIND_OF[b.species.locomotion] === "water" && !b.isDead,
  );
  if (water.length === 0) {
    return;
  }
  const out = water.find((b) => b === primary() || b === support()) ?? water[0];
  if (out !== primary() && out !== support()) {
    primaryIdx = roster.indexOf(out);
    refreshVisibility();
  }
  mount.mount(out);
}

bus.on((e) => {
  // A THROW, not a bond: the practice objective is about the motion, so a broken orb counts.
  if (e.type === "orbThrown") {
    advanceObjectives({ kind: "orb-thrown" });
  }
  if (e.type === "deepRefused") {
    tryAutoMountWater();
  }
  // THE INSTANCE, NOT THE COMPANION (issue #178): the fact carries the wild species that was bonded
  // (`wild-sproutle`, `penned-sproutle`), so "bond a WILD one" is a claim about the animal and not
  // about which quest happened to be active when the orb landed. `onBeastTamed` still gets `beastId`.
  if (e.type === "beastTamed") {
    advanceObjectives({ kind: "tamed", id: e.species });
  }
  // The event carries the bare species (`gloopling`); a cull objective names the CONTENT id it culls,
  // so the `enemy:` is put back on here rather than the filter being loosened to accept either.
  if (e.type === "enemyKilled") {
    advanceObjectives({ kind: "enemy-killed", id: `enemy:${e.species}` });
  }
  // A drop that reached the bag, however it got there — a beast fetching one counts, because what the
  // objective asks for is the THING, not the stoop.
  if (e.type === "itemPicked") {
    advanceObjectives({ kind: "item-picked", id: e.itemId });
  }
});

// ARRIVAL IS A PLACE, NOT A DOOR: a town has no gate to trip, so the fact is derived from where the
// hero is standing. `null` means open country, and the edge — not the state — is what fires, so
// standing in Redbriar does not re-discover it every slice.
let inTown: string | null = null;
function syncTownArrival(): void {
  const t0 = world.towns.nearest(player.position.x, player.position.z);
  // `radius` is the town's own footprint — the registry's answer to "are you in it". The height band
  // is what keeps a flying hero from arriving in a town he is passing over; generous downward,
  // because the ground under a hamlet on a slope is not the levelled height at its middle.
  const now =
    t0 &&
    inReach(
      t0.x,
      t0.y,
      t0.z,
      player.position.x,
      player.position.y,
      player.position.z,
      t0.radius,
      12,
      24,
    )
      ? t0.id
      : null;
  if (now === inTown) {
    return;
  }
  inTown = now;
  if (now === null) {
    return;
  }
  const id: ContentId = `town:${now}`;
  content.state.discover(id);
  advanceObjectives({ kind: "town-arrival", id });
}

// Hung off `onChange` so a dialogue row, `/quest` and a future timer all get the same `onStart`, once
// per real transition. `applyingSave` is the one refusal: a load would hand out the rewards again.
content.state.onChange((change) => {
  if (change.kind !== "quest" || applyingSave) {
    return;
  }
  const asset = content.get<QuestData>(change.name);
  if (!asset) {
    return;
  }
  const status = content.state.questStatus(change.name);
  // A STAGE ANSWERS A QUEST CHANGE ON THE NEXT FRAME, not on its own clock
  // (issue #229): the pen's despawn rode PRACTICE_POLL, so a probe — or a
  // player — could see the animal for most of a second after the turn-in that
  // released it. Zeroing every stage poll here turns that window into a frame.
  practicePollIn = 0;
  holdStagePollIn = 0;
  bossStagePollIn = 0;
  marketStagePollIn = 0;
  rookeryStagePollIn = 0;
  mawsStagePollIn = 0;
  if (status === "active") {
    content.run(asset.data.onStart);
    // "REACH X" IS A STATE, NOT AN EDGE, FOR A QUEST HANDED OUT INSIDE X: the
    // sea act's opener is given on the quay it asks you to reach (issue #152),
    // and `syncTownArrival` only fires on crossing the rim. Replayed once per
    // activation, with the arrival test's own numbers; later arrivals stay edges.
    if (inTown !== null) {
      advanceObjectives({ kind: "town-arrival", id: `town:${inTown}` });
    }
  }
  if (status === "completed") {
    content.run(asset.data.onComplete);
    grantQuestRewards(asset);
  }
});

// `xp` goes to the beasts that are out there (there is no hero level); everything else is an item id, and an unknown key is reported as the typo it is.
function grantQuestRewards(asset: ContentAsset<QuestData>): void {
  for (const [key, amount] of Object.entries(asset.data.rewards ?? {})) {
    const n = Math.round(amount);
    if (n <= 0) {
      continue;
    }
    if (key === "xp") {
      primary()?.gainXp(n);
      support()?.gainXp(Math.round(n * 0.6));
      continue;
    }
    if (!isKnownItem(key)) {
      reportContentIssue({
        severity: "warn",
        code: "unknown-ref",
        message: `reward "${key}" is not an item this build knows`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        field: "data.rewards",
        fix: "rewards are xp or an item id — anything a reward DOES is an onComplete action",
      });
      continue;
    }
    giveItemFromContent(key, n);
  }
}

// THE PENNED BEAST — the animal `quest:land/first-light` puts in the Encampment's pen (issue #178).
// The pen is the camp's own furniture, built by its layout; WHICH animal stands in it is quest
// dressing, staged here while the quest is live and let out when it closes. `enemy:penned-sproutle`
// is docile by data — aggro 0, so it never charges — and the pen's rails hold its wander, which is
// anchored to its own spawn. A lucky catch FILLS the practice, since a throw at a bonded species
// emits no `orbThrown`.
const PRACTICE_SPECIES = { enemy: "penned-sproutle", beast: "sproutle" } as const;
/** Seconds between checks. A stage prop, not a frame-loop concern. */
const PRACTICE_POLL = 1;
let practicePollIn = 0;

function tickPracticeBeast(dt: number): void {
  practicePollIn -= dt;
  if (practicePollIn > 0) {
    return;
  }
  practicePollIn = PRACTICE_POLL;

  const pen = world.tamingPen;
  if (!pen) {
    return; // a zone with no pen stages nothing
  }
  const asset = content.get<QuestData>("quest:land/first-light");
  const objective = asset?.data.objectives.find((o) => o.key === "bond-practice");
  const need = objective?.count ?? 1;
  const live = asset !== undefined && content.state.questStatus(asset.id) === "active";
  const wanted = live && content.state.progress(asset.id, "bond-practice") < need;

  // `!isDead`, NOT `targetable`: an animal inside a settling orb is `held` and
  // untargetable, and counting it as absent spawned a second occupant every
  // time a practice throw was in flight.
  const penned = combat.enemies.some((e) => !e.isDead && e.species === PRACTICE_SPECIES.enemy);

  // GONE AFTER: the pen empties the moment the quest no longer needs it — Gain
  // lets the animal go. Removed, never killed: a despawn drops nothing. ALL of
  // them, in case a throw-in-flight race ever doubled the occupant.
  if (!wanted) {
    while (combat.despawnOne(PRACTICE_SPECIES.enemy)) {
      // emptied below
    }
    return;
  }
  if (ownsSpecies(PRACTICE_SPECIES.beast)) {
    if (asset) {
      content.state.setProgress(asset.id, "bond-practice", need);
    }
    return;
  }
  if (!penned) {
    combat.spawnOne(PRACTICE_SPECIES.enemy, pen.x, pen.z);
  }
}

// THE STANDING STONES (world/waypoints.ts). Two rules, and both live here because both are about what
// the CHARACTER has done: a stone is lit by walking up to it, and a faint puts him back at the nearest
// one he has lit. The world sites them and draws them; which are lit is a content fact, and therefore
// saved, loaded and reset with every other fact he owns.
const waypointLit = (id: string): boolean => isId(id) && content.state.discovered(id);

/** Polled rather than evented: a stone is a PLACE, and being at one is a distance. */
let waypointPollIn = 0;

function tickWaypoints(dt: number): void {
  waypointPollIn -= dt;
  if (waypointPollIn > 0) {
    return;
  }
  // A quarter second, not the practice pen's whole one: the sense band (issue #250) is
  // crossed at a sprint in about a second, and a poll that ran once in it could miss.
  waypointPollIn = 0.25;
  const field = world.waypoints;
  if (!field) {
    return;
  }
  // NOTICED, not touched: passing on the road beside the stone lights it (issue #250).
  const at = field.sensing(player.position.x, player.position.y, player.position.z);
  if (!at || !isId(at.id) || waypointLit(at.id)) {
    return;
  }
  content.state.discover(at.id);
  field.setLit(waypointLit);
  bus.emit({ type: "toast", text: t("toast.waypointLit") });
}

// THE HOLD'S FLOOR — the other end of the same idea, for `quest:land/the-red-thread` (issue #150).
// A penned Sproutle with a thread through its bond, and the shard it was tied to, both at the room
// furthest in from the gateway. Staged rather than authored because the hold is generated: the zone
// has no place to put a prop, so the quest puts one there while it is being played and the world goes
// back to being a hold the moment it is over.
const HOLD_STAGE_SPECIES = { enemy: "wild-sproutle", beast: "sproutle" } as const;
/** What HOLDS it, and what killing frees it from. See `what-freeing-is` in the package. */
const HOLD_STAGE_ANCHOR = "thread-anchor";
const HOLD_STAGE_ITEM = "red-shard";
/** How far off the room's middle the three of them stand, so none is inside another. */
const HOLD_STAGE_APART = 3;
/** How near the room the hero must be for the living half of the scene to be put out. See below. */
const HOLD_STAGE_REACH = 55;
let holdStagePollIn = 0;

function tickHoldStage(dt: number): void {
  holdStagePollIn -= dt;
  if (holdStagePollIn > 0) {
    return;
  }
  holdStagePollIn = PRACTICE_POLL;
  // Only down there, and only while the quest is live: nothing is staged into a hold a player is
  // walking through for its own sake.
  if (zones.id !== "hold") {
    return;
  }
  const asset = content.get<QuestData>("quest:land/the-red-thread");
  if (!asset || content.state.questStatus(asset.id) !== "active") {
    return;
  }
  const spot = holdFloorSpot();
  // THE SHARD IS PLACED FROM ANYWHERE AND THE LIVING PARTS ARE NOT: a drop lies where it is put, but
  // an enemy further than `DESPAWN_DIST` from the hero is swept the same slice it is made — the floor
  // is 136 units from the gateway you arrive on, so staging them at the door spawned two animals into
  // an immediate despawn. They are put out when the player is close enough to keep them, which is also
  // when a player would first see the room.
  const near = inReach(
    spot.x,
    spot.y,
    spot.z,
    player.position.x,
    player.position.y,
    player.position.z,
    HOLD_STAGE_REACH,
    24,
    24,
  );

  if (near && content.state.progress(asset.id, "free-the-sproutle") < 1) {
    // The ANIMAL is scenery and the ANCHOR is the fight: it is spawned beside the beast it holds, and
    // the beast is left alone. A second bond of a species the player already has is refused before the
    // orb leaves the hand, so the Sproutle can never be the thing you interact with here.
    if (!combat.enemies.some((e) => e.targetable && e.species === HOLD_STAGE_ANCHOR)) {
      combat.spawnOne(HOLD_STAGE_ANCHOR, spot.x + HOLD_STAGE_APART, spot.z);
    }
    if (!combat.enemies.some((e) => e.targetable && e.species === HOLD_STAGE_SPECIES.enemy)) {
      combat.spawnOne(HOLD_STAGE_SPECIES.enemy, spot.x - HOLD_STAGE_APART, spot.z);
    }
  }

  if (content.state.progress(asset.id, "recover-shard") < 1) {
    const onFloor = combat.dropSnapshot().some((d) => d.itemId === HOLD_STAGE_ITEM && !d.claimed);
    if (!onFloor && bag.count(HOLD_STAGE_ITEM) === 0) {
      combat.spawnDrop(HOLD_STAGE_ITEM, spot.x, spot.y + 0.6, spot.z + HOLD_STAGE_APART);
    }
  }
}

// THE DROVE GROUND — Act 1's boss arena (issue #151). Open country outside Stonewatch, and NOT a prop
// of this quest: Act 4 fights `enemy:guardian/land` on the same ground (game-story.md §4), so nothing
// about the terrain, the town or the roads knows a boss is standing here. Kill it and the ground is
// what it was.
const BOSS_STAGE_ENEMY = "bellwether";
/**
 * How far out of Stonewatch it grazes, world units.
 *
 * 90 is past the town's own extent and its safe zone and far enough that
 * crossing it on foot is a walk you notice — which is the point of a boss the
 * story gates behind a mount — while staying inside `DESPAWN_DIST` of a hero who
 * has come out to meet it.
 */
const BOSS_STAGE_OUT = 90;
/** How near the arena the hero must be for the animal to be put out. Under the despawn radius. */
const BOSS_STAGE_REACH = 70;
let bossStagePollIn = 0;

/** Where the herd is: a fixed bearing off the town, so the arena is the same place every session. */
function droveGround(): { x: number; y: number; z: number } | null {
  const town = world.towns.get("stonewatch");
  if (!town) {
    return null;
  }
  // AWAY FROM THE GATE, so the walk out is across open country rather than back up the road the
  // player arrived on. The bearing is derived from the town's own gate and never stored.
  const away = Math.atan2(town.x - town.gateX, town.z - town.gateZ);
  const x = town.x + Math.sin(away) * BOSS_STAGE_OUT;
  const z = town.z + Math.cos(away) * BOSS_STAGE_OUT;
  return { x, y: world.getHeight(x, z), z };
}

function tickBossStage(dt: number): void {
  bossStagePollIn -= dt;
  if (bossStagePollIn > 0) {
    return;
  }
  bossStagePollIn = PRACTICE_POLL;
  if (zones.id !== "overworld") {
    return;
  }
  const asset = content.get<QuestData>("quest:land/the-bellwether");
  if (!asset || content.state.questStatus(asset.id) !== "active") {
    return;
  }
  if (content.state.progress(asset.id, "defeat-bellwether") >= 1) {
    return;
  }
  const spot = droveGround();
  if (!spot) {
    return;
  }
  // Same rule as the Hold's floor: an enemy further than `DESPAWN_DIST` from the hero is swept the
  // slice it is made, so the herd's leader is put out when somebody has come far enough to see it.
  if (
    !inReach(
      spot.x,
      spot.y,
      spot.z,
      player.position.x,
      player.position.y,
      player.position.z,
      BOSS_STAGE_REACH,
      30,
      30,
    )
  ) {
    return;
  }
  if (combat.enemies.some((e) => e.targetable && e.species === BOSS_STAGE_ENEMY)) {
    return;
  }
  combat.spawnOne(BOSS_STAGE_ENEMY, spot.x, spot.z);
}

// THE DROWNED MARKET — Kelphold's flooded flats (issue #154). Seaward of the quay,
// on beds a diver can just reach: he dives to 3.4 under the surface, so the stall
// floor lies on beds 4.6..6.6 — swimmable water, never the DARK kind, and the
// auto-mount (issue #153) is how you get out there at all. Like the drove ground,
// this is a claim on nothing: kill the quest and the flats are what they were.
const MARKET_ITEM = "salvage";
const MARKET_COMPONENT = "component-lens";
const MARKET_GUARD = "bridle-hound";
const MARKET_SALVAGE_N = 8;
/** Bed band the salvage lies on, chosen against the 3.4-unit dive: a diver
 *  reaches y ~4.6 and the pickup magnet spans 3, so a drop 0.6 over a 4.05 bed
 *  is in reach — and 4.05 keeps every stall strictly out of the DARK water. */
const MARKET_BED_MIN = 4.05;
const MARKET_BED_MAX = 7.2;
/** How near the hero must be before the market is dressed. Inside DESPAWN_DIST. */
const MARKET_STAGE_REACH = 60;
let marketStagePollIn = 0;
/** The stall spots, computed once per session: the terrain never moves under a quest. */
let marketSpots: Array<{ x: number; y: number; z: number }> | null = null;

/** The market's floor: divable columns marched seaward of Kelphold's quay, the
 *  component's stall last and furthest — the Bridle crew went deepest first. */
function drownedMarket(): Array<{ x: number; y: number; z: number }> | null {
  if (marketSpots) {
    return marketSpots;
  }
  const town = world.towns.get("kelphold");
  if (!town) {
    return null;
  }
  const spots: Array<{ x: number; y: number; z: number }> = [];
  // A fan off the quay: the flats fall away fast past an island's shore, so the
  // stalls take whatever divable shelf the seed left, quay-side first.
  for (let k = -4; k <= 4 && spots.length <= MARKET_SALVAGE_N + 2; k++) {
    const a = town.gateAngle + k * 0.25;
    const ux = Math.sin(a);
    const uz = Math.cos(a);
    for (let d = town.radius + 3; d < 90; d += 3) {
      const x = town.x + ux * d;
      const z = town.z + uz * d;
      const bed = world.getHeight(x, z);
      if (bed >= MARKET_BED_MIN && bed <= MARKET_BED_MAX && world.isWater(x, z)) {
        if (!spots.some((s) => Math.hypot(s.x - x, s.z - z) < 4)) {
          spots.push({ x, y: bed, z });
        }
      }
    }
  }
  // Shallow stalls first, the DEEPEST last: the component sits where the Bridle
  // crew dove first, and `tickMarketStage` reads the tail as its post.
  spots.sort((a, b) => b.y - a.y);
  if (spots.length <= MARKET_SALVAGE_N) {
    // Not enough flooded floor this seed: report rather than half-dress the market.
    reportContentIssue({
      severity: "warn",
      code: "unsupported",
      message: `the drowned market found ${spots.length} divable stalls off Kelphold; wants ${MARKET_SALVAGE_N + 1}`,
      assetId: "quest:sea/the-drowned-market",
      assetType: "quest",
      fix: "widen the lanes or the bed band in drownedMarket()",
    });
    return null;
  }
  marketSpots = spots;
  return spots;
}

function tickMarketStage(dt: number): void {
  marketStagePollIn -= dt;
  if (marketStagePollIn > 0) {
    return;
  }
  marketStagePollIn = PRACTICE_POLL;
  if (zones.id !== "overworld") {
    return;
  }
  const asset = content.get<QuestData>("quest:sea/the-drowned-market");
  if (!asset || content.state.questStatus(asset.id) !== "active") {
    return;
  }
  const spots = drownedMarket();
  if (!spots) {
    return;
  }
  const heart = spots[Math.floor(spots.length / 2)];
  if (
    !inReach(
      heart.x,
      heart.y,
      heart.z,
      player.position.x,
      player.position.y,
      player.position.z,
      MARKET_STAGE_REACH,
      30,
      30,
    )
  ) {
    return;
  }
  const drops = combat.dropSnapshot();
  // Salvage: keep exactly as many stalls dressed as the count still owes, so a
  // player who fished three out finds five more, never nine.
  // PROGRESS, not the bag: every pick advances the counter AND lands in the bag,
  // so counting both dressed seven stalls and then refused to dress the eighth.
  const salvageDown = drops.filter((d) => d.itemId === MARKET_ITEM && !d.claimed);
  let owe =
    MARKET_SALVAGE_N - content.state.progress(asset.id, "collect-salvage") - salvageDown.length;
  for (const spot of spots.slice(0, MARKET_SALVAGE_N)) {
    if (owe <= 0) {
      break;
    }
    if (salvageDown.some((d) => Math.hypot(d.x - spot.x, d.z - spot.z) < 2)) {
      continue;
    }
    combat.spawnDrop(MARKET_ITEM, spot.x, spot.y + 0.6, spot.z);
    owe--;
  }
  // The component, under its leashed guard at the farthest stall. The hound is
  // SCENERY WITH HIT POINTS (thread-anchor pattern): the Bridle crew got here
  // first, and Coil's case lands because it truly hurts nobody.
  const last = spots[spots.length - 1];
  if (
    content.state.progress(asset.id, "recover-component") < 1 &&
    bag.count(MARKET_COMPONENT) === 0 &&
    !drops.some((d) => d.itemId === MARKET_COMPONENT && !d.claimed)
  ) {
    combat.spawnDrop(MARKET_COMPONENT, last.x, last.y + 0.6, last.z);
  }
  if (!combat.enemies.some((e) => e.targetable && e.species === MARKET_GUARD)) {
    combat.spawnOne(MARKET_GUARD, last.x + 2, last.z);
  }
}

// THE ROOKERY — Gullspire's turned flock and Corwin Vane's wreck (issue #155).
// The Galebird lives in no biome table, which is the point: the flock is HERE
// because something turned it, so the quest stages it and nothing else does.
const ROOKERY_BIRD = "wild-galebird";
const ROOKERY_FLOCK_N = 3;
const ROOKERY_COMPONENT = "component-vane";
/** The wreck: a fixed bearing off the town, away from the gate — the drove-ground rule. */
const WRECK_OUT = 26;
const ROOKERY_STAGE_REACH = 60;
let rookeryStagePollIn = 0;

function vaneWreck(): { x: number; y: number; z: number } | null {
  const town = world.towns.get("gullspire");
  if (!town) {
    return null;
  }
  const away = Math.atan2(town.x - town.gateX, town.z - town.gateZ);
  const x = town.x + Math.sin(away) * WRECK_OUT;
  const z = town.z + Math.cos(away) * WRECK_OUT;
  return { x, y: world.getHeight(x, z), z };
}

function tickRookeryStage(dt: number): void {
  rookeryStagePollIn -= dt;
  if (rookeryStagePollIn > 0) {
    return;
  }
  rookeryStagePollIn = PRACTICE_POLL;
  if (zones.id !== "overworld") {
    return;
  }
  const asset = content.get<QuestData>("quest:sea/the-rookery");
  if (!asset || content.state.questStatus(asset.id) !== "active") {
    return;
  }
  const wreck = vaneWreck();
  if (!wreck) {
    return;
  }
  if (
    !inReach(
      wreck.x,
      wreck.y,
      wreck.z,
      player.position.x,
      player.position.y,
      player.position.z,
      ROOKERY_STAGE_REACH,
      30,
      30,
    )
  ) {
    return;
  }
  // The flock, until one is CALMED: a bond empties the objective, not the sky.
  // LIVING, not `targetable`: a bird held inside a mid-flight orb is still of
  // the flock, and counting it out restocked the third bird DURING the bond.
  if (content.state.progress(asset.id, "calm-the-flock") < 1) {
    const standing = combat.enemies.filter((e) => !e.isDead && e.species === ROOKERY_BIRD).length;
    for (let i = standing; i < ROOKERY_FLOCK_N; i++) {
      const a = (i / ROOKERY_FLOCK_N) * Math.PI * 2;
      combat.spawnOne(ROOKERY_BIRD, wreck.x + Math.sin(a) * 6, wreck.z + Math.cos(a) * 6);
    }
  }
  if (
    content.state.progress(asset.id, "recover-component") < 1 &&
    bag.count(ROOKERY_COMPONENT) === 0 &&
    !combat.dropSnapshot().some((d) => d.itemId === ROOKERY_COMPONENT && !d.claimed)
  ) {
    combat.spawnDrop(ROOKERY_COMPONENT, wreck.x, wreck.y + 0.6, wreck.z);
  }
}

// MAW'S REST — the reef ring, the act's boss, and Act 4's re-used arena (issues
// #156, #144). A LANDMARK, not a settlement: nothing is built, nothing loads —
// the site is the fourth anchor down the lobe, in water a swimmer can fight in.
// Kill the Brineholder and the ring is a place again; guardian-sea (Act 4)
// fights on the same ground, which is why the site helper knows no quest.
const MAWS_BOSS = "brineholder";
const MAWS_STAGE_REACH = 55;
/** The ring's water: deep enough to dive a fight in, never the unswimmable dark. */
const MAWS_BED_MIN = 4.2;
const MAWS_BED_MAX = 6.8;
let mawsStagePollIn = 0;
let mawsSite: { x: number; y: number; z: number } | null = null;

function mawsRest(): { x: number; y: number; z: number } | null {
  if (mawsSite) {
    return mawsSite;
  }
  const along = SEA_FULL + 320 + 3 * 380;
  const ax = SEA_DIR.x * along;
  const az = SEA_DIR.z * along;
  let best: { x: number; y: number; z: number } | null = null;
  let bestOff = Infinity;
  for (let ri = 0; ri <= 8; ri++) {
    const dist = (ri / 8) * 260;
    const steps = ri === 0 ? 1 : 14;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = ax + Math.sin(a) * dist;
      const z = az + Math.cos(a) * dist;
      const bed = world.getHeight(x, z);
      if (bed >= MAWS_BED_MIN && bed <= MAWS_BED_MAX && world.isWater(x, z)) {
        // Prefer the middle of the band: room to dive under the fight.
        const off = Math.abs(bed - (MAWS_BED_MIN + MAWS_BED_MAX) / 2) + dist * 0.005;
        if (off < bestOff) {
          bestOff = off;
          best = { x, y: bed, z };
        }
      }
    }
  }
  mawsSite = best;
  return best;
}

function tickMawsStage(dt: number): void {
  mawsStagePollIn -= dt;
  if (mawsStagePollIn > 0) {
    return;
  }
  mawsStagePollIn = PRACTICE_POLL;
  if (zones.id !== "overworld") {
    return;
  }
  const asset = content.get<QuestData>("quest:sea/what-the-tide-kept");
  if (!asset || content.state.questStatus(asset.id) !== "active") {
    return;
  }
  const ring = mawsRest();
  if (!ring) {
    return;
  }
  const near = inReach(
    ring.x,
    ring.y,
    ring.z,
    player.position.x,
    player.position.y,
    player.position.z,
    MAWS_STAGE_REACH,
    30,
    30,
  );
  if (!near) {
    return;
  }
  // ARRIVAL: a landmark is not a town, so the stage's own reach test marks it —
  // the same inReach rule town-arrival uses, pointed at a ring of water.
  if (content.state.progress(asset.id, "reach-maws-rest") < 1) {
    content.run([{ do: "progress.add", quest: asset.id, objective: "reach-maws-rest" }]);
  }
  if (
    content.state.progress(asset.id, "defeat-brineholder") < 1 &&
    !combat.enemies.some((e) => e.targetable && e.species === MAWS_BOSS)
  ) {
    combat.spawnOne(MAWS_BOSS, ring.x + 4, ring.z);
  }
}

// The camera looks through the pinned crosshair, so its forward vector IS the crosshair ray. A module scratch because casting must not allocate.
const _aim = new THREE.Vector3();
// Steer strength for a shot fired down the crosshair, as a fraction of full lock-on: 0.35 closes a small aiming
// error without dragging a shot onto something you did not point at.
const MOUNTED_HOMING = 0.35;
// Half-angle of the aim cone as a cosine. 0.94 is ~20 degrees.
const AIM_CONE_COS = 0.94;

/** The enemy the crosshair is on, or null. Not the nearest — the one aimed at. */
function enemyInAim(from: THREE.Vector3, aim: THREE.Vector3, range: number): Damageable | null {
  let best: Damageable | null = null;
  let bestDot = AIM_CONE_COS;
  for (const e of combat.enemies) {
    // `targetable` and not `isDead`: a beast inside a taming orb is invisible and refuses damage, and the crosshair must not lock onto the grass it stood on.
    if (!e.targetable) {
      continue;
    }
    const dx = e.position.x - from.x;
    const dy = e.position.y + 0.55 - from.y;
    const dz = e.position.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range || d < 1e-3) {
      continue;
    }
    const dot = (dx * aim.x + dy * aim.y + dz * aim.z) / d;
    if (dot > bestDot) {
      bestDot = dot;
      best = e as unknown as Damageable;
    }
  }
  return best;
}

// Half-angle of the ORB's aim cone as a cosine; 0.4 is ~66 degrees each side.
const ORB_AIM_CONE_COS = 0.4;

// Vertical half-band of the cylinder the orb's cone makes.
const ORB_AIM_RISE = 8;

// The NEAREST bondable beast you are roughly facing — nearest, not most-centred, so a wobble does not
// switch between two animals. Bondable outranks nearer, keeping the refusals reachable. It picks what
// the orb STEERS at; whatever it physically reaches first is what it hits.
function bondTargetInAim(def: ItemDef, from: THREE.Vector3, aim: THREE.Vector3): Damageable | null {
  // The look direction FLATTENED: a camera is always pitched, and a 3D cone dropped a Sproutle the hero was walking into at 2.5 units. A cylinder, like `inReach`.
  const ax = aim.x;
  const az = aim.z;
  const aLen = Math.hypot(ax, az);
  if (aLen < 1e-4) {
    return null;
  }
  const fx = ax / aLen;
  const fz = az / aLen;
  let best: Enemy | null = null;
  let bestD = Infinity;
  let bestBondable = false;
  for (const e of combat.enemies) {
    if (!e.targetable) {
      continue;
    }
    const dx = e.position.x - from.x;
    const dy = e.position.y + 0.55 - from.y;
    const dz = e.position.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > ORB_RANGE || d < 1e-3) {
      continue;
    }
    // The band, loose: what it refuses is the thing on the cliff above or in the ravine below.
    if (dy > ORB_AIM_RISE || dy < -ORB_AIM_RISE) {
      continue;
    }
    const hd = Math.hypot(dx, dz);
    if (hd < 1e-4) {
      continue;
    }
    if ((dx * fx + dz * fz) / hd < ORB_AIM_CONE_COS) {
      continue;
    }
    const bondable = combat.bondRefusal(def, e as unknown as Damageable) === "ok";
    if (best !== null && bestBondable && !bondable) {
      continue;
    }
    if (best !== null && bondable === bestBondable && d >= bestD) {
      continue;
    }
    best = e;
    bestD = d;
    bestBondable = bondable;
  }
  return best as unknown as Damageable | null;
}

// Shorter than a bow's ~26, longer than a skill's 12-16, and also the cone's search range, so an out-of-range beast is refused before the orb is spent.
const ORB_RANGE = 20;

// EVERY REFUSAL HAPPENS BEFORE THE ORB LEAVES THE HAND, and each says why — an arrow at nothing is
// free, an orb is sixty Cubloons. The odds are deliberately not checked. The outcome is returned as
// well as toasted, so `__dbgThrowOrb` need not scrape a translated sentence.
type ThrowOutcome = "thrown" | "noOrb" | "noTarget" | "notBondable" | "busy";

function throwReadiedOrb(explicitTarget?: Damageable | null, force?: boolean): ThrowOutcome {
  const def = readiedOrb ? itemDef(readiedOrb) : null;
  if (!def || bag.count(def.id) <= 0) {
    bus.emit({ type: "toast", text: t("toast.orbNone") });
    return "noOrb";
  }
  engine.camera.getWorldDirection(_aim);
  // The assist, unless a test hook named its own target — see `__dbgThrowOrb`.
  const target = explicitTarget ?? bondTargetInAim(def, player.position, _aim);
  if (!target) {
    bus.emit({ type: "toast", text: t("toast.orbNoTarget") });
    return "noTarget";
  }
  const refusal = combat.bondRefusal(def, target);
  if (refusal === "notBondable") {
    bus.emit({ type: "toast", text: t("toast.orbNotBondable") });
    return "notBondable";
  }
  if (refusal === "busy") {
    return "busy";
  }

  if (bag.remove(def.id, 1) !== 1) {
    return "noOrb";
  }
  // From the chest down the camera ray, or a close target is missed by his own body. With an explicit target the
  // direction is AT it, so a probe does not depend on the camera.
  _orbFrom.copy(player.position);
  _orbFrom.y += ORB_THROW_RISE;
  if (explicitTarget) {
    _aim.copy(explicitTarget.position).sub(_orbFrom);
    _aim.y += 0.55;
    if (_aim.lengthSq() < 1e-6) {
      _aim.set(0, 0, 1);
    }
    _aim.normalize();
  }
  combat.throwOrb(_orbFrom, _aim, def, target, force);
  refreshOrbHud();
  inventory.refresh();
  bus.emit({ type: "orbThrown", orbId: def.id });
  return "thrown";
}

/** Where a throw leaves the hero, above his feet. Chest height, as the bow is. */
const ORB_THROW_RISE = 1.1;
const _orbFrom = new THREE.Vector3();

const lastCast = { skill: "", aimed: false, homing: false, x: 0, y: 0, z: 0 };

function castFromBeast(beast: BeastActor, skill: SkillDef): void {
  const cd = cooldowns.get(skill.id) ?? 0;
  if (cd > 0) {
    return;
  }

  // Riding it changes where its skills go: from the saddle you are aiming, so the crosshair wins outright and the auto-target is not consulted.
  const aimed = mount.isMounted && beast === mount.beast;
  let target: Damageable | null = null;
  if (aimed) {
    engine.camera.getWorldDirection(_aim);
    // Face the mount along the shot so `beginCast`'s muzzle offset points the right way.
    if (Math.abs(_aim.x) + Math.abs(_aim.z) > 1e-4) {
      beast.forward.set(_aim.x, 0, _aim.z).normalize();
    }
    // A LITTLE homing from the saddle, and the target comes from the aim CONE rather than "nearest enemy" — curving onto something off to the side would be autoaim.
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
    // A fraction of full lock-on, so the crosshair stays the thing that decides where a shot goes.
    homingScale: aimed ? MOUNTED_HOMING : 1,
    attackStat: beast.stats.attack,
  });
  lastCast.skill = skill.id;
  lastCast.aimed = aimed;
  lastCast.homing = !!target;
  lastCast.x = dir.x;
  lastCast.y = dir.y;
  lastCast.z = dir.z;
  cooldowns.set(skill.id, skill.cooldown);
}

/** The lead beast's first four skills, or none at all with nobody leading. */
function hotbarSkills(): SkillDef[] {
  const lead = primary();
  if (!lead) {
    return [];
  }
  return lead.knownSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillDef => !!s)
    .slice(0, 4);
}

// THE ORBS ARE FIRST AND ALWAYS THERE, so a den is worth the walk before the first bond: a shop that opened empty would read as broken.
function buildOffers(): ShopOffer[] {
  const offers: ShopOffer[] = [];
  for (const id of ORB_IDS) {
    const def = ITEMS[id];
    if (def.storePrice === undefined) {
      continue;
    }
    offers.push({
      kind: "item",
      itemId: def.id,
      name: itemName(def),
      description: def.descriptionKey ? t(def.descriptionKey) : "",
      price: def.storePrice,
      affordable: shards() >= def.storePrice,
      color: def.color,
      orbTier: def.orbTier,
      held: bag.count(def.id),
    });
  }
  for (const beast of [primary(), support()]) {
    if (!beast) {
      continue;
    }
    for (const id of beast.species.skills) {
      const def = getSkill(id);
      if (!def || def.storePrice === undefined) {
        continue;
      }
      offers.push({
        kind: "skill",
        skill: def,
        price: def.storePrice,
        owned: beast.knownSkillIds.includes(id),
        beastId: beast.id,
        beastName: t(beast.species.nameKey),
        affordable: shards() >= def.storePrice,
      });
    }
  }
  return offers;
}

function tryOpenShop(): void {
  if (hud.isShopOpen()) {
    return;
  }
  // THROUGH `Input`, never straight to the DOM: `releaseLock` clears the INTENT, which is how `onLockLost` tells a player's Escape from a deliberate release.
  input.releaseLock();
  hud.openShop(
    t("shop.skillDen.title"),
    buildOffers(),
    (i) => {
      // REBUILT rather than captured: the list the player clicked was rendered before this purchase,
      // and a second click on a stale record would spend Cubloons the first one already spent.
      const offer = buildOffers()[i];
      if (!offer || !offer.affordable) {
        return;
      }
      if (offer.kind === "item") {
        spent += offer.price;
        bag.add(offer.itemId, 1);
        refreshBagChips();
        // FIRST ORB BOUGHT IS READIED — opening the bag to arm it is a step between the purchase and the point of it.
        if (!readiedOrb) {
          readiedOrb = offer.itemId;
        }
        refreshOrbHud();
        inventory.refresh();
        bus.emit({ type: "toast", text: t("toast.bought", { item: offer.name }) });
      } else {
        if (offer.owned) {
          return;
        }
        spent += offer.price;
        // By ID, not by name: this matched on the display name until species names moved into the string table, at
        // which point a translated build charged for a skill nobody learned.
        const beast = [primary(), support()].find((p) => p !== null && p.id === offer.beastId);
        beast?.learnSkill(offer.skill.id);
        bus.emit({
          type: "toast",
          text: t("toast.learnedSkill", {
            beast: offer.beastName,
            skill: t(offer.skill.nameKey),
          }),
        });
      }
      hud.setShards(shards());
      hud.openShop(
        t("shop.skillDen.title"),
        buildOffers(),
        () => {},
        () => hud.closeShop(),
      );
    },
    () => hud.closeShop(),
  );
}

const beastHud = (p: BeastActor | null): BeastHudInfo | null =>
  p === null
    ? null
    : {
        // Resolved here, not in the HUD: `BeastHudInfo` is a snapshot of what to DRAW, and `t(key)` with no vars hands
        // back the table's own string, so this allocates nothing per frame.
        name: t(p.species.nameKey),
        element: p.species.element,
        locomotion: p.species.locomotion,
        level: p.level,
        xp: p.xp,
        xpToNext: p.xpToNext,
        hp: p.hp,
        maxHp: p.maxHp,
      };

// Photo mode (for the visual critic pipeline):   ?photo=1&cam=x,y,z&look=x,y,z&beast=<speciesId>&anim=<action>  — cam/look offset the spawn point.
const params = new URLSearchParams(location.search);
// From flags rather than `params`: world/sway.ts needs the same answer, and two parses is one too many.
const photoMode = flags.photo;
const parseVec = (s: string | null, fallback: THREE.Vector3): THREE.Vector3 => {
  if (!s) {
    return fallback;
  }
  const [x, y, z] = s.split(",").map(Number);
  return new THREE.Vector3(x, y, z);
};
if (photoMode) {
  if (params.get("hud") === "0") {
    const style = document.createElement("style");
    style.textContent = "body > *:not(#app), #app > *:not(canvas) { display: none !important; }";
    document.head.appendChild(style);
  }
  const beastId = params.get("beast");
  if (beastId || params.get("poff")) {
    // Portraits happen on FLAT ground so the camera is never buried in a hillside.
    const idx = Math.max(
      0,
      roster.findIndex((p) => p.species.id === beastId),
    );
    const ring = (idx / roster.length) * Math.PI * 2;
    const base = world.spawnPoint;

    /** Max height deviation within ~3 units — low means level ground. */
    const flatness = (x: number, z: number): number => {
      const h = world.getHeight(x, z);
      let worst = 0;
      for (const [dx, dz] of [
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
        [2, 2],
        [-2, -2],
      ]) {
        worst = Math.max(worst, Math.abs(world.getHeight(x + dx, z + dz) - h));
      }
      return worst;
    };

    // Buildings became the backdrop of three portraits, putting the subject in hard building shadow against a black wall.
    const backdropPenalty = (x: number, z: number): number => {
      let worst = 0;
      for (const s of world.shopPositions) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 14) {
          worst = Math.max(worst, (14 - d) * 0.5);
        }
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
        if (world.getHeight(x, z) < world.waterLevel + 0.6) {
          continue;
        } // not in the shallows
        // Score on level ground AND a clean backdrop, not flatness alone.
        const score = flatness(x, z) + backdropPenalty(x, z);
        if (score < bestScore) {
          bestScore = score;
          best = new THREE.Vector3(x, 0, z);
        }
        if (score < 0.7) {
          break;
        } // good enough, take it
      }
      if (bestScore < 0.7) {
        break;
      }
    }

    const spot = params.get("poff") ? parseVec(params.get("poff"), base).add(base) : (best ?? base);
    player.position.x = spot.x;
    player.position.z = spot.z;
    player.position.y = Math.max(world.getHeight(spot.x, spot.z) + 0.1, world.waterLevel + 0.2);
  }
  if (beastId) {
    const idx = roster.findIndex((p) => p.species.id === beastId);
    if (idx >= 0) {
      primaryIdx = idx;
    }
    // PHOTO MODE IGNORES OWNERSHIP — how every portrait in shots/ was taken, and the one door into a party slot that skips `grantBeast`.
    if (idx >= 0) {
      owned.add(roster[idx].id);
    }
    // Staged portraits show ONE subject: hide the hero and every other beast.
    roster.forEach((p, i) => p.setVisible(i === primaryIdx));
    player.root.visible = false;
  }
}
const photoCam = parseVec(params.get("cam"), new THREE.Vector3(6, 4, 8)).add(world.spawnPoint);
const photoLook = parseVec(params.get("look"), new THREE.Vector3(0, 1, 0)).add(world.spawnPoint);
const photoAnim = params.get("anim");
let photoAnimTimer = 0;

// Null without a touch screen, so nothing is added to the DOM and there is no per-frame cost.
touch = photoMode ? null : TouchControls.attach(input);

// The language can change while the game runs, and almost nothing needs to hear: strings are looked up
// on their way to the HUD each slice. Below is the exhaustive set that CAPTURED one earlier. Zone names
// are getters and cannot go stale.
onLanguageChange(() => {
  composeKeyHints();
  hud.relabel();
  touch?.relabel();
  // The F3 panel too: it was written with a `relabel` nothing ever called, and it now carries the spawner's headings and every row's display name.
  perfPanel.relabel();
  // The tracker's rows are resolved by THIS file (quest words live in content), so `relabel` can only invalidate the guard — the redraw is this push.
  refreshQuests();
});

// Non-null wherever the API exists, so a pad arriving mid-session is caught.
const prefs = loadPrefs();
const lookAxes: LookAxes = {
  invertX: flags.invertLookX ?? prefs.invertLookX,
  invertY: flags.invertLookY ?? prefs.invertLookY,
};
pad = photoMode ? null : GamepadControls.attach(input, { look: lookAxes });
touch?.setLookAxes(lookAxes);

feedback = photoMode
  ? null
  : new FeedbackSystem({
      bus,
      camera: player.cam,
      pad: () => pad?.current ?? null,
      // Live, per frame: rumble belongs to the device in the player's hands, so a pad left plugged in stops buzzing the moment the keyboard is touched.
      tactileInput: () => input.tactile,
      hapticFeedback: prefs.hapticFeedback,
      hapticIntensity: flags.haptics ?? prefs.hapticIntensity,
      shakeIntensity: flags.shake ?? prefs.shakeIntensity,
    });

interface DebugProbes {
  __dbgPlayerPos: () => { x: number; y: number; z: number };
  __dbgCam: () => {
    x: number;
    y: number;
    z: number;
    pitch: number;
    dir: { x: number; y: number; z: number };
  };
  __dbgCamYaw: () => number;
}
(window as unknown as DebugProbes).__dbgPlayerPos = () => ({
  x: player.position.x,
  y: player.position.y,
  z: player.position.z,
});
const _dbgDir = new THREE.Vector3();
/** Scratch for the compass's per-frame camera forward. Never allocate in frame(). */
const _compassFwd = new THREE.Vector3();
/** Scratch for `__dbgHurt`'s source position. */
const _hurtFrom = new THREE.Vector3();
(window as unknown as DebugProbes).__dbgCam = () => {
  engine.camera.getWorldDirection(_dbgDir);
  return {
    x: engine.camera.position.x,
    y: engine.camera.position.y,
    z: engine.camera.position.z,
    pitch: (Math.asin(Math.max(-1, Math.min(1, _dbgDir.y))) * 180) / Math.PI,
    // The camera looks THROUGH the pinned crosshair, so this vector IS the crosshair ray.
    dir: { x: _dbgDir.x, y: _dbgDir.y, z: _dbgDir.z },
  };
};
// -- debug-hook maths. Shared by the reporting hooks below; degrees are rounded to
// two places because a probe compares text.
const deg = (r: number): number => +((r * 180) / Math.PI).toFixed(2);
const bearingOf = (dx: number, dz: number): number => Math.atan2(dx, dz);
/** Shortest signed arc, so a probe reads -179 rather than 181. */
const shortest = (a: number): number => {
  let v = a;
  while (v > Math.PI) {
    v -= Math.PI * 2;
  }
  while (v < -Math.PI) {
    v += Math.PI * 2;
  }
  return v;
};
const degShortest = (r: number): number => deg(shortest(r));

// THE OPENING POSE in one read. `greeter` is the nearest resident the pose was composed against, so
// `beside`/`faceGap` need no name or seed. `camFromFace` is the assertion, in degrees: ~0 is his face,
// ~180 is over his shoulder, which is every other moment in the game.
(window as unknown as { __dbgStart: () => unknown }).__dbgStart = () => {
  const s = world.playerStart;
  const g = world.npcs?.all[0] ?? null;
  return {
    start: {
      x: +s.position.x.toFixed(2),
      y: +s.position.y.toFixed(2),
      z: +s.position.z.toFixed(2),
      yaw: +s.yaw.toFixed(3),
    },
    player: {
      x: +player.position.x.toFixed(2),
      z: +player.position.z.toFixed(2),
      facing: +player.facing.toFixed(3),
    },
    greeter: g && {
      id: g.id,
      x: +g.x.toFixed(2),
      y: +g.y.toFixed(2),
      z: +g.z.toFixed(2),
      restYaw: +g.restYaw.toFixed(3),
    },
    /** Distance from the hero's start to the greeter, in world units. */
    beside: g ? +Math.hypot(s.position.x - g.x, s.position.z - g.z).toFixed(2) : null,
    /** How far the hero's facing differs from the greeter's, degrees. */
    faceGap: g ? degShortest(s.yaw - g.restYaw) : null,
    // Angle between the camera arm and the hero's facing, degrees; 0 is his face.
    camFromFace: degShortest(
      Math.atan2(
        engine.camera.position.x - player.position.x,
        engine.camera.position.z - player.position.z,
      ) - player.facing,
    ),
    /** How far the start is from the world's own reference point. */
    fromSpawn: +Math.hypot(
      s.position.x - world.spawnPoint.x,
      s.position.z - world.spawnPoint.z,
    ).toFixed(2),
  };
};

// Compass state. `rel` is the signed shortest-arc bearing to the marker in degrees, `clamped` says it fell off the end of the strip and is parked at the edge.
(window as unknown as { __dbgCompass: () => unknown }).__dbgCompass = () => hud.compassDebug();
(window as unknown as DebugProbes).__dbgCamYaw = () =>
  Math.atan2(
    engine.camera.position.x - player.position.x,
    engine.camera.position.z - player.position.z,
  );
(window as unknown as { __dbgInput: () => unknown }).__dbgInput = () => ({
  axisFwd: input.axisFwd,
  axisSide: input.axisSide,
  lookActive: input.lookActive,
  touchActive: input.touchActive,
  // Two answers, not one: `autoRelock` is the host's permission, `relockPending` whether there is a pointer to recover at all.
  autoRelock: input.autoRelock,
  relockPending: input.relockPending,
  touchOverlay: !!document.querySelector(".bs-touch"),
  // The OVERLAY's look pad — a different object from `__dbgPad`'s, and null with no overlay.
  touchLookAxes: touch?.lookAxes ?? null,
  // ADDITIVE: tools/test-touch.mjs dumps this wholesale, so keys may be added but never renamed.
  ...(input.debugState() as object),
  vel: {
    x: +player.velocity.x.toFixed(2),
    y: +player.velocity.y.toFixed(2),
    z: +player.velocity.z.toFixed(2),
  },
  onGround: player.onGround,
  // Which SURFACE holds him up: false is the terrain, true a tree crown (see World.climbTopAt).
  onCanopy: player.onCanopy,
  isClimbing: player.isClimbing,
  attacking: player.isAttacking,
  isSwimming: player.isSwimming,
  isMounted: player.isMounted,
  isDead: player.isDead,
  // The keys the game swallows before the browser can act on them, so tools/test-keybinds.mjs can cross-check
  // the bindings table rather than trust that somebody remembered.
  captured: Input.capturedCodes(),
});

// `keyboardLock` is whether the browser CAN be asked for Escape and `escapeLocked` whether it granted it — they disagree exactly where the feature is broken.
(window as unknown as { __dbgFullscreen: () => unknown }).__dbgFullscreen = () => ({
  supported: fullscreenSupported(),
  active: isFullscreen(),
  keyboardLock: keyboardLockSupported(),
  escapeLocked: escapeIsLocked(),
  survivesEscape: fullscreenSurvivesEscape(),
});

// `connected` stays false until the pad's first button press on Chrome — the browser's rule.
(window as unknown as { __dbgPad: () => unknown }).__dbgPad = () => pad?.debugState() ?? null;

// `haptics.issues` is the number of real playEffect calls, which is what proves the 12 Hz cadence rather than the mixer re-issuing every frame.
(window as unknown as { __dbgFeedback: () => unknown }).__dbgFeedback = () =>
  feedback?.debugState() ?? null;

// `output` is the number to watch a fade on — `volume` is the master and does not move during one.
(window as unknown as { __dbgMusic: () => unknown }).__dbgMusic = () => music.debugState();
// TEST HOOK: the loop seam is 85 s into the shortest track, which no probe can wait for.
(window as unknown as { __dbgMusicSeek: (seconds: number) => void }).__dbgMusicSeek = (
  seconds: number,
) => music.seek(seconds);
// TEST HOOK: naming a scene directly is the only way to ask what an area NOBODY scored plays —
// walking to a gateway is a minute of driving and reaches the two zones this build ships.
(window as unknown as { __dbgMusicScene: (s: string | null) => void }).__dbgMusicScene = (
  s: string | null,
) => music.setScene(s);

// TEST HOOK: waiting for a real enemy to connect is not deterministic enough to assert feedback timing, or the invulnerability window, against.
(window as unknown as { __dbgHurt: (n: number) => void }).__dbgHurt = (n: number) => {
  _hurtFrom.set(player.position.x, player.position.y, player.position.z - 1);
  player.takeDamage(n, _hurtFrom);
};

// Submerged camera. `amount` is the smoothed 0..1 ramp the tint, murk and bubbles key off,
// `depth` is how far the LENS is under (not the hero), `fogNear` proves the murk reached the scene.
(window as unknown as { __dbgUnder: () => unknown }).__dbgUnder = () => ({
  amount: +underwater.amount.toFixed(3),
  depth: +underwater.depth.toFixed(2),
  camY: +engine.camera.position.y.toFixed(2),
  overWater: world.isWater(engine.camera.position.x, engine.camera.position.z),
  fogNear: +((engine.scene.fog as THREE.Fog | null)?.near ?? -1).toFixed(1),
  fogFar: +((engine.scene.fog as THREE.Fog | null)?.far ?? -1).toFixed(1),
  // Per-channel absorption the distance is filtered by — 1,1,1 above water.
  fogAbsorb: ((): number[] => {
    const f = engine.scene.fog as THREE.Fog | null;
    return f ? [+f.color.r.toFixed(3), +f.color.g.toFixed(3), +f.color.b.toFixed(3)] : [];
  })(),
});

// Mount state. `aimed` says whether the last cast's direction came from the crosshair or from the auto-target.
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
  /** The ANIMAL's altitude — what the flight and dive clamps act on. See `bodyY`. */
  bodyY: mount.isMounted ? +mount.bodyY.toFixed(2) : null,
  // The dive (issue #103): the two things `bodyY` cannot give — the swim gait, and depth under the float line without a probe restating WADE_DEPTH.
  swimming: mount.isSwimming,
  diveDepth: +mount.diveDepth.toFixed(2),
  // Both, because "nothing is unlocked" and "this hold is being refused" are different claims and inferring one from the other would pass with the gate wired to nothing.
  unlocked: mountUnlocks.list(),
  refusal: mount.refusal(primary()),
  ground: +world.getHeight(player.position.x, player.position.z).toFixed(2),
  lastCast: { ...lastCast },
});

// `__dbgFetch` is read-only; `__dbgDrop` is a TEST HOOK, the only way to stage a given item without
// farming the loot table. THE TAMING SURFACE below is what test-taming asserts on: the ODDS a throw
// would have and whether a ceremony is playing. Passing a `species` aims without steering a camera.
(window as unknown as { __dbgTaming: (species?: string) => unknown }).__dbgTaming = (species) => {
  const def = readiedOrb ? itemDef(readiedOrb) : null;
  engine.camera.getWorldDirection(_aim);
  const target = !def
    ? null
    : species
      ? (nearestEnemyOfSpecies(species) as unknown as Damageable | null)
      : bondTargetInAim(def, player.position, _aim);
  return {
    readied: readiedOrb,
    tier: def?.orbTier ?? null,
    held: readiedOrb ? bag.count(readiedOrb) : 0,
    bonding: combat.bonding,
    owned: [...owned],
    lead: primary()?.id ?? null,
    support: support()?.id ?? null,
    target: target
      ? {
          species: combat.bondSpeciesOf(target),
          hp: +target.hp.toFixed(1),
          maxHp: target.maxHp,
          refusal: def ? combat.bondRefusal(def, target) : "notBondable",
          chance: def ? +combat.bondChance(def, target).toFixed(4) : 0,
        }
      : null,
  };
};

// TEST HOOKS for bonding. `__dbgWeaken` is the only way to reach "a beast at 10% health", and the claim
// under test is that the odds MOVE with health. `__dbgThrowOrb` forces the outcome so both settle paths
// are assertable; the odds are asserted off `__dbgTaming().target.chance`.
(
  window as unknown as {
    __dbgWeaken: (species: string, hpFrac: number) => unknown;
  }
).__dbgWeaken = (species, hpFrac) => {
  const e = nearestEnemyOfSpecies(species);
  if (!e) {
    return { ok: false, why: `no live "${species}" nearby` };
  }
  e.hp = Math.max(1, Math.round(e.maxHp * Math.max(0, Math.min(1, hpFrac))));
  // The ID, so a probe can keep measuring THIS animal: the nearest one can change between two calls, which is the ambiguity an "it was removed" assertion must not have.
  return { ok: true, id: e.root.id, species, hp: e.hp, maxHp: e.maxHp };
};

// TEST HOOK for a cull objective: put one animal down through the SAME `takeDamage` a swing lands, so
// the death sweep, the drops and the `enemyKilled` fact all run. It fires nothing itself — the kill is
// counted next slice, which is what a probe must advance for.
(
  window as unknown as {
    __dbgKillEnemy: (species: string) => unknown;
  }
).__dbgKillEnemy = (species) => {
  const e = nearestEnemyOfSpecies(species);
  if (!e) {
    return { ok: false, why: `no live "${species}" nearby` };
  }
  _hurtFrom.set(e.position.x, e.position.y, e.position.z - 1);
  e.takeDamage(e.maxHp * 4, _hurtFrom);
  return { ok: true, id: e.root.id, species, hp: e.hp, dead: e.isDead };
};

(
  window as unknown as {
    __dbgThrowOrb: (species?: string, force?: boolean) => unknown;
  }
).__dbgThrowOrb = (species, force) => {
  const target = species ? nearestEnemyOfSpecies(species) : null;
  if (species && !target) {
    return { outcome: "noTarget", why: `no live "${species}" nearby` };
  }
  const dist = target
    ? +Math.hypot(
        target.position.x - player.position.x,
        target.position.z - player.position.z,
      ).toFixed(2)
    : null;
  const outcome = throwReadiedOrb(target as unknown as Damageable | null, force);
  return { outcome, species: species ?? null, id: target?.root.id ?? null, dist };
};

function nearestEnemyOfSpecies(species: string) {
  let best = null;
  let bd = Infinity;
  for (const e of combat.enemies) {
    if (!e.targetable || e.species !== species) {
      continue;
    }
    const d = (e.position.x - player.position.x) ** 2 + (e.position.z - player.position.z) ** 2;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// ATOMIC on purpose: reading bodies, camera and target separately let the animal walk between them and
// lost a beast inside the cone one run in three. `offDeg` is the HORIZONTAL angle the cone is a cosine of.
(window as unknown as { __dbgOrbAim: (species: string) => unknown }).__dbgOrbAim = (species) => {
  const e = nearestEnemyOfSpecies(species);
  const def = readiedOrb ? itemDef(readiedOrb) : null;
  if (!e || !def) {
    return null;
  }
  engine.camera.getWorldDirection(_aim);
  const dx = e.position.x - player.position.x;
  const dy = e.position.y + 0.55 - player.position.y;
  const dz = e.position.z - player.position.z;
  const hd = Math.hypot(dx, dz);
  const aLen = Math.hypot(_aim.x, _aim.z);
  const dot = hd > 1e-3 && aLen > 1e-4 ? (dx * (_aim.x / aLen) + dz * (_aim.z / aLen)) / hd : 0;
  const picked = bondTargetInAim(def, player.position, _aim);
  return {
    species,
    offDeg: +((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI).toFixed(1),
    dist: +Math.hypot(dx, dy, dz).toFixed(2),
    rise: +dy.toFixed(2),
    picked: picked !== null,
    pickedThis: picked === (e as unknown as Damageable),
  };
};

(window as unknown as { __dbgFetch: () => unknown }).__dbgFetch = () => {
  // NULL WHERE THERE IS NO BEAST rather than an object of nulls: "it did not fetch" and "there is no support
  // beast" are different results and only one is a bug in the fetch rule.
  const sup = support();
  const lead = primary();
  return {
    shards: shards(),
    bag: bag.entries().map((e) => ({ id: e.def.id, count: e.count })),
    drops: combat.dropSnapshot(),
    owned: [...owned],
    support: sup
      ? {
          // Probes report the IDENTIFIER, not the display name: a tool must not fail under `?lang=sv`.
          id: sup.id,
          fetching: sup.isFetching,
          carrying: sup.isCarrying,
          item: sup.fetchItemId,
          pos: { x: +sup.position.x.toFixed(2), z: +sup.position.z.toFixed(2) },
        }
      : null,
    primary: lead ? { id: lead.id, fetching: lead.isFetching } : null,
  };
};
// `dy` and `reach` are the pair issue #70 is about — nine units away horizontally and ninety below — and `needed` is the gate the beam's landing rule reads.
(window as unknown as { __dbgCompanions: () => unknown }).__dbgCompanions = () => {
  const p = player.position;
  const one = (b: BeastActor, role: string) => ({
    role,
    id: b.id,
    transit: b.inTransit,
    drawn: b.isDrawn,
    dead: b.isDead,
    // Screen size of its light-travel streak; both halves of issue #136 read off this one number.
    beam: +b.beamSize.toFixed(3),
    // The ridden beast is placed by the saddle and never runs follow steering.
    ridden: mount.beast === b,
    d: +Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(2),
    dy: +(p.y - b.position.y).toFixed(2),
    pos: { x: +b.position.x.toFixed(2), y: +b.position.y.toFixed(2), z: +b.position.z.toFixed(2) },
  });
  const lead = primary();
  const sup = support();
  return {
    player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    ground: +world.getHeight(p.x, p.z).toFixed(2),
    needed: lead?.supportNeeded ?? false,
    // An EMPTY LIST with nothing bonded, so a probe counting rows reads the truth.
    beasts: [...(lead ? [one(lead, "primary")] : []), ...(sup ? [one(sup, "support")] : [])],
    // Bonded but not in a slot: outside `beasts`, because every test-companion assertion there means "following
    // the hero" — but issue #136 is what a benched beast left running.
    bench: ownedBeasts()
      .filter((b) => b !== lead && b !== sup)
      .map((b) => ({ id: b.species.id, drawn: b.isDrawn, beam: +b.beamSize.toFixed(3) })),
  };
};
// TEST HOOK: put the hero at an absolute column in the ACTIVE zone; "walk 1.4 s and hope" cannot
// separate a 3.0-unit enter radius from a 5.0-unit exit radius. `y` is taken literally, which is the
// only way onto a flying island — a deck is invisible to anything not attached — and landing inside the
// ride volume attaches him next slice. `refitHero` is the other half (issue #142 §12a): `carveAt` sinks
// a column by up to 1.62, so a path authored under a standing hero leaves him inside the ground, and
// only ever UP, because a hero in the air should fall.
const refitHero = (): void => {
  const floor = Math.max(world.getHeight(player.position.x, player.position.z), world.waterLevel);
  if (player.position.y >= floor) {
    return;
  }
  mount.teleport(player.position.x, player.position.z, floor);
  player.position.y = floor;
  player.velocity.set(0, 0, 0);
};

// THE TRAIL TO THE GATEWAY — issue #142's third profile doing real work: narrow, no lamps, no bridging.
// Laid through `World.addPath` because the gate's spot is chosen from the FINISHED world and cannot be
// known inside `planSettlements`; the rebuild is nine chunks at boot.
{
  // Read through a call: `gateSite` IS set by now, but flow analysis narrows it to null. `as` would say "trust me" about the one thing worth checking.
  const gate = ((): { x: number; z: number } | null => gateSite)();
  if (gate !== null) {
    // IT LEAVES THE ROAD AT THE NEAREST POINT TO THE GATE: from the spawn it would cross whatever
    // carriageway is in the way (issue #45), and this reads better besides. And not from INSIDE a town —
    // the nearest road point is the end of a spur, so the trail set off through the middle of Stonewatch.
    let head = { x: world.spawnPoint.x, z: world.spawnPoint.z };
    let headD = Infinity;
    for (const r of world.towns.roads) {
      for (let i = 0; i < r.path.length; i += 3) {
        const x = r.path[i];
        const z = r.path[i + 2];
        if (
          world.towns.all.some((town) => Math.hypot(town.x - x, town.z - z) < town.outerRadius + 8)
        ) {
          continue;
        }
        // AND WITH A CLEAR RUN TO THE GATE: the spur curves, so the point closest to the gate can still
        // have a carriageway between it and where the trail is going. Measured — it did.
        if (world.pathRunCrosses(x, z, gate.x, gate.z)) {
          continue;
        }
        // And clear of what is already standing: a trail refuses BUILT things only prospectively, and the lamps
        // were stamped when the network was planned. The margin is timber plus half-width.
        if (world.pathRunHitsBuilt(x, z, gate.x, gate.z, TRAIL_PROFILE.deckEdge)) {
          continue;
        }
        const d = Math.hypot(x - gate.x, z - gate.z);
        if (d < headD) {
          headD = d;
          head = { x, z };
        }
      }
    }
    const laid = world.addPath({
      from: [head.x, head.z],
      to: [gate.x, gate.z],
      profile: "trail",
    });
    // REPORTED, NOT SWALLOWED: a world quietly short of the path to its own dungeon is the silent failure the refusal machinery exists to prevent.
    if (laid.error) {
      reportContentIssue({
        severity: "warn",
        code: "gateway-trail-refused",
        message: `The trail to the gateway was refused: ${laid.error}`,
        fix: "move the gateway, or give the trail a profile that can bridge",
      });
    } else if (laid.crossings > 0) {
      // Starting from the nearest road point is what should make this zero; if it is not, the trail runs over a carriageway with nothing at the meeting.
      reportContentIssue({
        severity: "warn",
        code: "gateway-trail-crosses",
        message:
          `The trail to the gateway crosses ${laid.crossings} road(s) ` +
          "with no junction at the meeting",
        fix: "move the gateway clear of the road network, or merge the crossing",
      });
    }
  }
}

// THE ONE WAY TO MOVE THE HERO ACROSS THE WORLD — the saddle first (while
// mounted his position is rewritten from the mount every slice, so setting the
// fields alone was a teleport that did nothing), then the ground that is there
// NOW. The map's waystone travel and `__dbgTp` share it.
function teleportTo(x: number, z: number, y?: number): void {
  mount.teleport(x, z, y);
  player.position.x = x;
  player.position.z = z;
  player.position.y = y ?? Math.max(world.getHeight(x, z), world.waterLevel);
  player.velocity.set(0, 0, 0);
}
(window as unknown as { __dbgTp: (x: number, z: number, y?: number) => void }).__dbgTp = teleportTo;
// TEST HOOK, `__dbgTp`'s argument exactly: it DRIVES the map marker without the
// panel, which is how test-saves plants a flag to round-trip.
(window as unknown as { __dbgMarker: (x: number | null, z?: number) => void }).__dbgMarker = (
  x,
  z,
) => {
  setPlayerMarker(x === null || z === undefined ? null : { x, z });
};
// Swing the camera so a held W walks along that bearing — movement is camera-relative. A WALK bearing, and the swing takes a few hundred ms.
(window as unknown as { __dbgAim: (bearing: number) => void }).__dbgAim = (bearing) => {
  player.aimCamera(bearing);
};
// TEST HOOK — FAST-FORWARD: drain N seconds of simulation synchronously, because everything the old
// wall-clock waits waited for is a fixed-step function of the slice count. Each iteration emulates one
// perfect 60 Hz frame, so a held key stays held and the streamer gets its full per-frame budget. It
// does not render. Clamped to 300 s so a runaway argument cannot hang the tab.
(window as unknown as { __dbgAdvance: (seconds: number) => unknown }).__dbgAdvance = (seconds) => {
  if (!playing) {
    return { playing: false, slices: 0 };
  }
  const s = Math.min(Math.max(0, Number(seconds) || 0), 300);
  const slices = Math.round(s * SIM_HZ);
  const t0 = performance.now();
  for (let i = 0; i < slices; i++) {
    pad?.poll(SIM_DT);
    simulate(SIM_DT, true, !photoMode);
    feedback?.drain(SIM_DT);
    input.endFrame();
  }
  return {
    playing: true,
    slices,
    simSeconds: s,
    wallMs: +(performance.now() - t0).toFixed(1),
  };
};
// Melee aim assist as the game would answer it now, running the shipped query rather than a copy.
// `angleFromCrosshair` is the SELECTION criterion and `turn` is what the swing does from his current
// facing; they differ by his heading lag, which is what lets a turn exceed the cone. `inReach` is the
// same query with the cone opened to 180, so a REFUSAL is checkable — null target beside non-null
// inReach is the cone working, both null is nobody in range.
(window as unknown as { __dbgAimAssist: () => unknown }).__dbgAimAssist = () => {
  engine.camera.getWorldDirection(_aimDir);
  _dbgStrike.copy(player.position);
  _dbgStrike.y += 1.25;
  const target = combat.bestMeleeTarget(
    _dbgStrike,
    _aimDir,
    SWORD_REACH,
    AIM_ASSIST_CONE_COS,
    player.position.y,
  );
  // Named `reachable` because `inReach` is the imported proximity rule; the REPORTED field keeps the name tools already read.
  const reachable = combat.bestMeleeTarget(_dbgStrike, _aimDir, SWORD_REACH, -1, player.position.y);
  const aim = bearingOf(_aimDir.x, _aimDir.z);
  const describe = (e: Damageable | null): unknown => {
    if (!e) {
      return null;
    }
    const dx = e.position.x - _dbgStrike.x;
    const dz = e.position.z - _dbgStrike.z;
    return {
      x: +e.position.x.toFixed(2),
      z: +e.position.z.toFixed(2),
      distance: +Math.hypot(dx, dz).toFixed(2),
      // Feet to feet, the axis the selection is gated on — `distance` 1.5 with `rise` 6 is issue #78.
      rise: +(e.position.y - player.position.y).toFixed(2),
      angleFromCrosshair: deg(Math.abs(shortest(bearingOf(dx, dz) - aim))),
      turn: deg(
        Math.abs(shortest(bearingOf(dx, dz) - bearingOf(player.forward.x, player.forward.z))),
      ),
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
// `recycledAirborne` must stay 0 for the process, `retired` counts settled particles shrunk early, `dropped` bursts refused with everything airborne.
(window as unknown as { __dbgTouchFx: () => unknown }).__dbgTouchFx = () => ({
  ...touchFx.stats(),
  crown: world.crownContactAt(
    player.position.x,
    player.position.y + 1,
    player.position.z,
    0.65,
    _dbgCrown,
  )
    ? { ..._dbgCrown }
    : null,
});
// TEST HOOK: force a burst without finding a tree, the only practical way to drive the pool to exhaustion on demand.
(window as unknown as { __dbgTouchBurst: (n: number) => number }).__dbgTouchBurst = (n) =>
  touchFx.forceBurst(player, n);
(window as unknown as { __dbgDrop: (id: string, dx: number, dz: number) => void }).__dbgDrop = (
  id,
  dx,
  dz,
) => {
  const x = player.position.x + dx,
    z = player.position.z + dz;
  combat.spawnDrop(id, x, world.getHeight(x, z) + 0.5, z);
};
// TEST HOOK, and the only way test-textsize sees MOST of the HUD at once: half the panels the 16px
// floor covers are transient (issue #17 named three). A hook rather than the probe reaching into `hud`,
// because the shop needs the real skill registry and prices.
(window as unknown as { __dbgStageHud: () => boolean }).__dbgStageHud = () => {
  hud.showHint(t("hint.npcTalk", { key: hud.interactPrompt, name: t("npc.gain.name") }));
  hud.showDialogue(
    t("npc.gain.name"),
    t("npc.gain.greeting"),
    t("npc.dialogue.close", { key: hud.interactPrompt }),
  );
  hud.setMountHold(0.42);
  hud.setMounted(t("beast.emberfox.name"), "ground");
  hud.setBag([
    { def: itemDef("sunberry"), count: 3 },
    { def: itemDef("glowpebble"), count: 12 },
  ]);
  bus.emit({ type: "beastLevelUp", beastId: "emberfox", nameKey: "beast.emberfox.name", level: 4 });
  bus.emit({
    type: "toast",
    text: t("toast.fetched", { beast: "Emberfox", item: "Sunberries", n: 3 }),
  });
  tryOpenShop();
  return true;
};

let started = false;

// Frame cap in fps; `?fps=<n>` overrides, `?fps=0` removes. 120 by default: rAF is already pinned to
// the display, so uncapped meant 165 frames of a 4.97 ms main-thread scene (80.5% of a core walking).
// 120 rather than 60 because a player feels that difference and not 120 to 165. A DEADLINE, not a sleep
// — an interval cap undershoots — and skipped time rolls into the next frame.
const DEFAULT_FPS_CAP = 120;
const fpsCap = Number(params.get("fps") ?? DEFAULT_FPS_CAP);
engine.setFpsCap(fpsCap);
const debug = new DebugOverlay(engine.renderer, fpsCap);
if (params.get("debug") === "1") {
  debug.toggle();
}

// Composition-root policy: gfx.ts knows bloom is a boolean, this file knows what a bloom pass and a chunk mesh are.
const gfx = new Gfx({
  grass: (on) => world.setLayerVisible("grass", on),
  terrainDistance: (metres) => {
    world.setTerrainDistance(metres);
    engine.setViewDistance(metres);
  },
  foliageDistance: (metres) => world.setFoliageDistance(metres),
  props: (on) => world.setLayerVisible("props", on),
  water: (on) => world.setLayerVisible("water", on),
  clouds: (on) => world.setLayerVisible("clouds", on),
  shadows: (on) => engine.setShadowsEnabled(on),
  ao: (on) => engine.setPassEnabled("ao", on),
  bloom: (on) => engine.setPassEnabled("bloom", on),
  aa: (on) => engine.setPassEnabled("aa", on),
  // `?fps=` beats the stored preference for this load and never writes it back, the same resolution the look-axis and shake overrides use.
  fpsCap: (n) => {
    const v = params.get("fps") !== null ? fpsCap : n;
    engine.setFpsCap(v);
    debug.setFpsCap(v);
  },
});
// The settings panel's Graphics tab may now reach it. See `gfxLive` at the top.
gfxLive = true;
const timePresets = [
  { phase: null, labelKey: "gfx.time.auto" },
  { phase: 0.25, labelKey: "gfx.time.dawn" },
  { phase: 0.5, labelKey: "gfx.time.noon" },
  { phase: 0.75, labelKey: "gfx.time.dusk" },
  { phase: 0, labelKey: "gfx.time.midnight" },
] as const;
// Eight metres along his facing: far enough not to appear inside him, near enough to be on screen, a little past sword reach. `forward` is (sin yaw, cos yaw).
const SPAWN_AHEAD = 8;
// NEAR is a body's width, so a hut cannot land on the hero; FAR is where a building stops reading as placed.
const AIM_NEAR = 2;
const AIM_FAR = 60;
const AIM_STEP = 0.5;
/** Scratch for the crosshair ray. A spawn is a click, but the rule is the rule. */
const _spawnRay = new THREE.Vector3();

// On the ground under the crosshair, so a hut can go across a road without walking there.
function spawnSpot(): { x: number; z: number; yaw: number } {
  const cam = engine.camera.position;
  engine.camera.getWorldDirection(_spawnRay);
  let hitX = player.position.x + Math.sin(player.facing) * SPAWN_AHEAD;
  let hitZ = player.position.z + Math.cos(player.facing) * SPAWN_AHEAD;
  // Only a ray going DOWN can meet a heightfield within a useful distance; one at the horizon would march the whole way and find the first hill across the map.
  if (_spawnRay.y < -0.02) {
    let lo = AIM_NEAR;
    let hi = 0;
    for (let d = AIM_NEAR; d <= AIM_FAR; d += AIM_STEP) {
      const x = cam.x + _spawnRay.x * d;
      const z = cam.z + _spawnRay.z * d;
      if (cam.y + _spawnRay.y * d <= world.getHeight(x, z)) {
        hi = d;
        break;
      }
      lo = d;
    }
    if (hi > 0) {
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) * 0.5;
        const x = cam.x + _spawnRay.x * mid;
        const z = cam.z + _spawnRay.z * mid;
        if (cam.y + _spawnRay.y * mid <= world.getHeight(x, z)) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      hitX = cam.x + _spawnRay.x * hi;
      hitZ = cam.z + _spawnRay.z * hi;
    }
  }
  // A structure FACES THE HERO: `Accum.add` maps a template's local +z to (sin yaw, cos yaw), so
  // the bearing from the spot back to him turns the front wall toward whoever placed it.
  const dx = player.position.x - hitX;
  const dz = player.position.z - hitZ;
  const yaw = dx === 0 && dz === 0 ? player.facing + Math.PI : Math.atan2(dx, dz);
  return { x: hitX, z: hitZ, yaw };
}

// Composition-root policy, like `GfxSinks`: core/spawn.ts knows a branch has rows, this knows what a
// bag, a beast, an `Enemy` and a settlement part are. Every branch is re-derived per draw and labels go
// through `t()`, so the tree follows `/content load`, a bond and a language switch. The structure rows
// have no string keys deliberately: `hut-a` is a part name, never shown to a player.
const spawnCatalogue: SpawnCatalogue = {
  branches: () => [
    {
      id: "items",
      labelKey: "spawn.items",
      noteKey: "spawn.items.note",
      target: "bag",
      rows: Object.values(ITEMS).map((d) => ({
        id: d.id,
        label: itemName(d, 1),
        hint: d.kind,
      })),
    },
    {
      id: "beasts",
      labelKey: "spawn.beasts",
      noteKey: "spawn.beasts.note",
      target: "party",
      rows: ALL_SPECIES.map((sp) => ({
        id: sp.id,
        label: t(sp.nameKey),
        had: ownsSpecies(sp.id),
      })),
    },
    {
      id: "enemies",
      labelKey: "spawn.enemies",
      noteKey: "spawn.enemies.note",
      target: "world",
      rows: enemySpecies().map((s) => ({
        id: s.id,
        label: t(s.nameKey),
        hint: s.flying ? "flying" : "ground",
      })),
    },
    /**
     * THE QUEST YOU ARE PLAYING, DRIVEN. A row per quest the journal would offer
     * or is tracking, and clicking one takes the next step the quest itself is
     * up to: an offered quest is ACCEPTED, an accepted one is HANDED IN. Two
     * presses cross a quest, which is the shape a tester needs — the state in
     * between is the one a real acceptance produces.
     *
     * It exists because the alternative is playing an act to reach the quest
     * after it, and a story of twenty quests cannot be tested from the front
     * every time (issue #143).
     */
    {
      id: "quests",
      labelKey: "spawn.quests",
      noteKey: "spawn.quests.note",
      target: "world",
      rows: content.query
        .available<QuestData>("quest")
        .filter((asset) => {
          const tab = questTab(asset);
          return tab === "active" || tab === "available";
        })
        .map((asset) => ({
          id: asset.id,
          label: resolveText(asset.name, `[${asset.id}]`),
          // The id carries the arc, so a search for "land" finds the act.
          // What the CLICK will do, which is the row's whole affordance: an offered
          // quest is accepted, an accepted one is handed in.
          hint: content.state.questStatus(asset.id) === "active" ? "hand in" : "accept",
        })),
    },
    {
      id: "structures",
      labelKey: "spawn.structures",
      noteKey: "spawn.structures.note",
      target: "world",
      // The take-it-all-down row leads, because this is the branch that leaves something behind: a hut
      // stands where you put it. Its id is starred so it can never collide with a part's name.
      rows: world.debugSpawn
        ? [
            { id: "*clear", label: t("spawn.clear"), hint: "reset" },
            ...world.debugSpawn.names().map((n) => ({ id: n, label: n })),
          ]
        : [],
    },
  ],
  spawn: (branchId, rowId) => {
    const at = spawnSpot();
    if (branchId === "items") {
      // Straight through the console command's own body: currency is not a bag entry and a count has a
      // plural form, and two surfaces with two opinions about either is the bug this avoids.
      return giveItem(rowId, 1);
    }
    if (branchId === "beasts") {
      return devGrant(rowId);
    }
    if (branchId === "enemies") {
      const e = combat.spawnOne(rowId, at.x, at.z);
      return e ? `${t("spawn.placed")} ${rowId}` : t("spawn.unknown");
    }
    if (branchId === "quests") {
      return devDriveQuest(rowId);
    }
    if (branchId === "structures") {
      const spawner = world.debugSpawn;
      if (!spawner) {
        return t("spawn.noStructures");
      }
      if (rowId === "*clear") {
        spawner.clear();
        return `${t("spawn.clear")} (${spawner.count})`;
      }
      if (!spawner.spawn(rowId, at.x, at.z, at.yaw)) {
        return t("spawn.unknown");
      }
      return `${t("spawn.placed")} ${rowId} (${spawner.count})`;
    }
    return t("spawn.unknown");
  },
};

// The PANEL owns the rows; this owns what a change means — store it, rebuild the mesh, and let
// `setHairStyle` resolve "no colour yet". The rig is read every time: `exitToTitle` builds a new hero.
const appearance: AppearanceControl = {
  styles: HAIR_STYLES,
  swatches: HAIR_SWATCHES,
  style: () => player.hairStyle,
  colour: () => player.hairColour,
  setStyle: (id) => {
    storeHairStyle(id);
    player.setHair(id, storedHairColour());
  },
  setColour: (hex) => {
    storeHairColour(hex);
    player.setHair(player.hairStyle, hex);
  },
  reset: () => {
    storeHairStyle(HAIR_STYLES[0].id);
    storeHairColour(null);
    player.setHair(HAIR_STYLES[0].id, null);
  },
};

// The path editor's policy (issue #142 §12), which the panel does not have.
let pathProfileId = "footpath";
let pathLength = 60;
let pathCrossing = false;
const pathEdit: PathEditControl = {
  profiles: [
    { id: "footpath", labelKey: "path.profile.footpath" },
    { id: "road", labelKey: "path.profile.road" },
  ],
  lengths: [30, 60, 90, 120, 160],
  profile: () => pathProfileId,
  setProfile: (id: string) => {
    pathProfileId = id;
  },
  length: () => pathLength,
  setLength: (n: number) => {
    pathLength = n;
  },
  crossing: () => pathCrossing,
  setCrossing: (v: boolean) => {
    pathCrossing = v;
  },
  lay: () => {
    // `facing` and not the camera's yaw: `cam.yaw` is the bearing FROM the hero TO the camera, so it would lay the path out behind him.
    const a = player.facing;
    const r = world.addPath({
      from: [player.position.x, player.position.z],
      to: [
        player.position.x + Math.sin(a) * pathLength,
        player.position.z + Math.cos(a) * pathLength,
      ],
      profile: pathProfileId,
      cross: pathCrossing,
      refit: refitHero,
    });
    if (r.error) {
      return `refused: ${r.error}`;
    }
    // EVERY REFUSAL REACHES THE SCREEN (§12f).
    for (const why of r.refused) {
      devConsole?.print(`path: no merge — ${why}`);
    }
    const nodes =
      r.nodes.length > 0
        ? `, ${r.nodes.length} junction(s)`
        : r.refused.length > 0
          ? ", no merge"
          : "";
    return `${r.id}: ${r.length} units${nodes}`;
  },
};

/**
 * Drive a quest one step from the Debug panel: ACCEPT it, or hand it in.
 *
 * WHICH STEP IS THE QUEST'S OWN STATE, not a second row: an offered quest is
 * accepted, an accepted one is filled and completed. That is the order a player
 * walks and it is the order a tester needs — the row is pressed twice to cross a
 * quest, and the journal in between is the one a real acceptance produces.
 *
 * Both steps go through the ONE seam a real quest goes through, `setQuestStatus`
 * — the lifecycle runner is what pays `onStart` and `onComplete`, so nothing
 * here hands out anything itself and there is no second path through a quest.
 *
 * FILLED BEFORE COMPLETED, and not merely marked done, because progress is a
 * fact other content reads: a giver's dialogue tests an objective's count to
 * decide what to say, so a finished quest with its counters at zero leaves the
 * world disagreeing with the journal. An unknown or already-finished id is
 * reported rather than acted on — a panel row is user input, the same rule
 * `spawnOne` follows.
 */
function devDriveQuest(id: string): string {
  const asset = content.get<QuestData>(id);
  if (!asset) {
    return t("spawn.unknown");
  }
  const name = resolveText(asset.name, `[${asset.id}]`);
  const status = content.state.questStatus(id);
  if (status === "completed") {
    return `${t("spawn.questDone")} ${name}`;
  }
  if (status !== "active") {
    content.state.setQuestStatus(id, "active");
    return `${t("spawn.questTaken")} ${name}`;
  }
  for (const objective of asset.data.objectives) {
    content.state.setProgress(id, objective.key, objective.count ?? 1);
  }
  content.state.setQuestStatus(id, "completed");
  return `${t("spawn.questDone")} ${name}`;
}

// Which quest is meant to grant each mount — the F3 rows' last column. Here rather than in
// core/types.ts because it is a fact about the CAMPAIGN (game-story.md §5), not about the type.
const MOUNT_QUEST_KEYS: Record<MountKind, StringKey> = {
  ground: "mount.ground.quest",
  water: "mount.water.quest",
  flying: "mount.flying.quest",
};

const perfPanel = new PerfPanel(
  gfx,
  {
    presets: timePresets,
    get: () => dayNight.debugOverride,
    set: (phase) => dayNight.setDebugOverride(phase),
  },
  spawnCatalogue,
  appearance,
  pathEdit,
  {
    kinds: MOUNT_KINDS.map((id) => ({
      id,
      labelKey: MOUNT_KIND_KEYS[id].name,
      noteKey: MOUNT_QUEST_KEYS[id],
    })),
    has: (id) => mountUnlocks.has(id as MountKind),
    // Through the same door the console uses, so the bag's badges follow a flip from either surface.
    set: (id, on) => {
      devUnlockMounts(on ? "unlock" : "lock", id);
    },
  },
);

// `at()` runs only while the pointer is free and only over the canvas — on movement, not per frame —
// which makes a screen-space scan affordable. A PROJECTION, not a raycast. Nearest wins.
const cursors = new Cursors();
const _curProj = new THREE.Vector3();
/** Second scratch, so the NPC scan never clones. See the loop below. */
const _curNpc = new THREE.Vector3();
const cursorDirector = new CursorDirector(cursors, {
  at: (px, py) => {
    const rect = engine.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    /** Screen distance in px, or Infinity when the point is behind the lens. */
    const screenGap = (p: THREE.Vector3, lift: number): number => {
      _curProj.set(p.x, p.y + lift, p.z).project(engine.camera);
      if (_curProj.z > 1) {
        return Infinity;
      }
      const sx = rect.left + (_curProj.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-_curProj.y * 0.5 + 0.5) * rect.height;
      return Math.hypot(sx - px, sy - py);
    };
    // Generous: a pixel-exact hit test on a 2-metre creature 40 units away is unusable.
    const REACH = 46;
    // An OBJECT rather than two locals: flow analysis does not follow assignments made inside a
    // closure, so a `let best = null` written only by `offer` narrows to `never` by the return.
    const best = { gap: Infinity, state: null as CursorState | null };
    const offer = (gap: number, state: CursorState): void => {
      if (gap < REACH && gap < best.gap) {
        best.gap = gap;
        best.state = state;
      }
    };
    for (const e of combat.enemies) {
      if (e.hp > 0) {
        offer(screenGap(e.position, 0.9), "attack-target");
      }
    }
    // `_curNpc` rather than a clone per NPC: this runs on every mouse move.
    for (const n of world.npcs?.all ?? []) {
      _curNpc.set(n.x, n.y, n.z);
      offer(screenGap(_curNpc, 1.2), "inspect");
    }
    // A skill den is a building you can walk into and read — the magnifier's meaning.
    for (const s of world.shopPositions) {
      offer(screenGap(s, 1.5), "inspect");
    }
    return best.state;
  },
});
void cursors.load();

// WHEN THE MOUSE CURSOR IS SHOWING, for two reasons. ALT IS A HOLD: no state to get out of step with
// what the player believes, and it matches every editor camera (it does mean Alt+click, which some
// window managers claim). A MENU is the other — menus are clicked and have already released the pointer
// — gated on `lastSource`, so a pad player driving one gets no cursor. Neither is a modal.
let cursorFree = false;
/** Alt at the previous call, so this can tell a RELEASE from a menu closing. */
let altWasHeld = false;
function updateCursorMode(): void {
  const altHeld = input.down("AltLeft") || input.down("AltRight");
  const altJustReleased = altWasHeld && !altHeld;
  altWasHeld = altHeld;
  const menuUp =
    (startMenu?.isOpen ?? false) ||
    pauseMenu.isOpen ||
    hud.isShopOpen() ||
    hud.isControlsOpen() ||
    inventory.isOpen ||
    journal.isOpen ||
    map.isOpen;
  const want = altHeld || (menuUp && input.lastSource === "kbm");
  if (want === cursorFree) {
    return;
  }
  cursorFree = want;
  cursorDirector.setEnabled(want);
  if (altHeld) {
    input.releaseLock();
  } else if (altJustReleased && !menuUp && !isTouchPrimary()) {
    // ONLY an Alt release: `cursorFree` also goes false when a menu closes, and taking the lock back there
    // ran a keyup ahead of the menu's own `onClose`, whose Escape then dropped it 8 ms later.
    input.requestLock();
  }
}

// EVENT-DRIVEN, because `frame()` does not run until New Game and the poster is one of the two places the cursor is wanted.
for (const ev of ["keydown", "keyup", "mousemove", "mousedown", "pointerlockchange"]) {
  (ev === "pointerlockchange" ? document : window).addEventListener(
    ev,
    () => updateCursorMode(),
    true,
  );
}
// The panel sees a click first and returns false unless it landed on one of its rows.
window.addEventListener(
  "mousedown",
  (e) => {
    if (perfPanel.handleClick(e.target, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
// A drag owns the cursor until it ends — the pointer leaves the handle within a few pixels.
perfPanel.onDragCursor = (state, dragging) => {
  if (!dragging) {
    cursorDirector.lock(null);
    return;
  }
  cursorDirector.lock((state as CursorState | null) ?? cursors.debug().state ?? "move");
};

// PINNED rather than just enabled: the F2 overlay also turns sampling on, and closing it must not silence a run the harness in tools/ asked for.
if (params.get("perf") === "1") {
  perf.pin();
}
let lastPrograms = 0;

const devConsole = photoMode ? null : new DevConsole();
const colliderView = new ColliderView(engine.scene, world);
bound.push(colliderView);
// `colliders=1` starts them visible for a staged capture; photo mode has no console to type into.
if (params.get("colliders") === "1") {
  colliderView.setVisible(true);
}
// TWO SURFACES, ONE BODY: `/give` and the F3 spawner row both need an unknown id refused, currency kept out of the bag, and the plural form in the answer.
function giveItem(id: string, count: number): string {
  if (!isKnownItem(id)) {
    return `no such item "${id}" — /give with no arguments lists them`;
  }
  const n = Math.max(1, count);
  const def = itemDef(id);
  if (def.kind === "currency") {
    // Currency is not in the bag (core/items.ts), so it joins the pickup total rather than being refused — a console answering "no" here would be right and useless.
    pickupTotal += n;
    hud.setShards(shards());
    return `${shards()} ${itemName(CURRENCY, shards())}`;
  }
  const got = bag.add(id, n);
  refreshBagChips();
  inventory.refresh();
  return `${itemName(def, got)} x${got}`;
}
devConsole?.register({
  name: "give",
  args: "<item id> [count]",
  help: "Put items in the bag. No arguments lists the catalogue.",
  run: (args) => {
    const [id, raw] = args;
    // No argument lists what there is, which makes the ids discoverable — as `/gfx` and `/nature` do.
    if (!id) {
      return Object.values(ITEMS)
        .map((d) => `${d.id.padEnd(17)} ${d.kind}`)
        .join("\n");
    }
    return giveItem(id, Number(raw) || 1);
  },
});
devConsole?.register({
  name: "show-colliders",
  args: "[on|off]",
  help: "Toggle collision volumes: green = solid (tree discs + structure boxes), blue = climbable.",
  run: (args) => {
    const on = args[0] === "on" ? true : args[0] === "off" ? false : !colliderView.isVisible;
    colliderView.setVisible(on);
    return on
      ? `colliders ON — ${colliderView.count} drawn, ${colliderView.boxCount} settlement ` +
          `boxes and ${colliderView.ridgeCount} roof arches (green solid, blue climb), ` +
          `tallest cage ${colliderView.tallestCage.toFixed(1)}`
      : "colliders OFF";
  },
});
devConsole?.register({
  name: "gfx",
  args: "[<setting> [on|off|<n>]]",
  help: "Read or set the F3 performance toggles. No arguments lists them.",
  run: (args) => {
    const [id, raw] = args;
    // No argument: the whole table. The ids are the same strings the panel and __dbgGfx use.
    if (!id) {
      const snap = gfx.snapshot();
      return (
        GFX_OPTIONS.map((o) => `${o.id.padEnd(9)} ${String(snap[o.id])}`).join("\n") +
        "\n(F3 opens the panel)"
      );
    }
    const opt = GFX_OPTIONS.find((o) => o.id === id);
    if (!opt) {
      return `no such setting "${id}" — ${GFX_OPTIONS.map((o) => o.id).join(", ")}`;
    }
    if (raw === undefined) {
      return `${opt.id} ${String(gfx.get(opt.id))}`;
    }
    // `on`/`off` for switches, a bare number for choice rows; the registry validates and answers with what it stored, so a value outside the list reports the default.
    const value = opt.choices ? Number(raw) : raw !== "off" && raw !== "false" && raw !== "0";
    const now = gfx.set(opt.id, value);
    perfPanel.refresh();
    return `${opt.id} ${String(now)}`;
  },
});
// A changed density reaches the ground you are standing on. `world` is a `let` reassigned on a zone switch, so this rebuilds whichever is current.
nature.onChange(() => world.rebuildProps());
devConsole?.register({
  name: "nature",
  args: "[<param> [<value>] | <area>.<param> [<value>|reset] | reset]",
  help:
    "Read or set the world's nature densities. 1 is the baseline; an area " +
    "multiplies it. No arguments lists everything.",
  run: (args) => {
    const [lhs, raw] = args;
    if (!lhs) {
      const snap = nature.snapshot();
      const rows = NATURE_PARAMS.map(
        (p) => `${p.id.padEnd(8)} ${snap.baseline[p.id].toFixed(2)}  ${p.help}`,
      );
      const areas = Object.entries(snap.areas).map(([k, v]) => `${k.padEnd(16)} x${v.toFixed(2)}`);
      return [
        "baseline (1 = the designed world)",
        ...rows,
        areas.length ? `\nareas\n${areas.join("\n")}` : "\nno area overrides",
        "\n/nature grass 0.5   /nature forest.trees 2   /nature forest.trees reset",
      ].join("\n");
    }
    if (lhs === "reset") {
      nature.reset();
      return "nature reset — rebuilding the streamed chunks";
    }
    const dot = lhs.indexOf(".");
    const id = (dot < 0 ? lhs : lhs.slice(dot + 1)) as NatureParamId;
    if (!NATURE_PARAMS.some((p) => p.id === id)) {
      return `no such parameter "${id}" — ${NATURE_PARAMS.map((p) => p.id).join(", ")}`;
    }
    if (dot < 0) {
      if (raw === undefined) {
        return `${id} ${nature.base(id).toFixed(2)}`;
      }
      return `${id} ${nature.setBase(id, Number(raw)).toFixed(2)} — rebuilding`;
    }
    // An AREA is a biome id today, unvalidated on purpose: the set widens as the world grows named
    // regions, and a typo shows up as an override that changes nothing rather than a refusal.
    const area = lhs.slice(0, dot) as NatureAreaId;
    if (raw === undefined) {
      return `${area}.${id} x${nature.areaFactor(area, id).toFixed(2)}`;
    }
    if (raw === "reset") {
      nature.setArea(area, id, null);
      return `${area}.${id} back to the baseline — rebuilding`;
    }
    const v = nature.setArea(area, id, Number(raw));
    return `${area}.${id} x${v.toFixed(2)} = ${(nature.base(id) * v).toFixed(2)} — rebuilding`;
  },
});

// `/content` — read the graph and drive its lazy half by hand. The load and release arms are the point:
// __dbgContent reports the rest, and what a console can do is TRY IT. Under the `debug` lease, never
// `boot` (spec §12.4), and `load` prints when it arrives rather than blocking the frame.
devConsole?.register({
  name: "content",
  args: "[load <pkg> | release <pkg> | check]",
  help:
    "Inspect loaded content packages, load or release one, or print the " +
    "validation diagnostics. No arguments lists what is loaded.",
  run: (args) => {
    const [verb, pkg] = args;
    if (!verb) {
      const packs = content.packages.map(
        (p) =>
          `${p.id.padEnd(12)} ${String(p.assets.length).padStart(3)} assets  ` +
          `[${p.leases.join(" ")}]  ${p.source}`,
      );
      const counts = ["town", "npc", "biome", "enemy", "quest"].map(
        (ty) => `${ty.padEnd(6)} ${content.all(ty).length}`,
      );
      const bad = [...content.diagnostics(), ...contentIssues()].filter(
        (d) => d.severity === "error" || d.severity === "fatal",
      ).length;
      return [
        packs.length ? `packages\n${packs.join("\n")}` : "no packages loaded",
        `\nassets\n${counts.join("\n")}`,
        `\n${bad} error(s) — /content check`,
        "\n/content load <pkg>   /content release <pkg>",
      ].join("\n");
    }
    if (verb === "check") {
      const all = [...content.diagnostics(), ...contentIssues()];
      if (all.length === 0) {
        return "no findings";
      }
      return all
        .map(
          (d) =>
            `${d.severity.padEnd(5)} ${d.code.padEnd(16)} ` +
            `${d.assetId ?? "-"}${d.field ? ` .${d.field}` : ""}\n      ${d.message}` +
            (d.fix ? `\n      fix: ${d.fix}` : ""),
        )
        .join("\n");
    }
    if (verb === "load" || verb === "release") {
      if (!pkg) {
        return `which package? /content ${verb} <pkg>`;
      }
      if (verb === "release") {
        content.release(pkg, "debug");
        return `released "${pkg}" (debug lease) — ${content.packages.length} loaded`;
      }
      void content.load(pkg, "debug").then((r) => {
        devConsole?.print(
          r.loaded
            ? `loaded "${r.pkg}": ${r.assets.length} assets, ${r.diagnostics.length} finding(s)`
            : `"${r.pkg}" was already loaded; added a debug lease`,
        );
        for (const d of r.diagnostics) {
          devConsole?.print(`  ${d.severity} ${d.code} ${d.message}`);
        }
      });
      return `loading "${pkg}"…`;
    }
    return `unknown — /content [load <pkg> | release <pkg> | check]`;
  },
});
// The body of `/mount` and of `__dbgRide`, extracted so the two cannot drift — typing `/mount finnick`
// is a key edge per character. The console answers in SPECIES IDS. Below it, `/mount unlock|lock` is the
// separate door for the story's three unlocks (and `__dbgUnlockMount`'s body); bare `unlock` means all.
function devUnlockMounts(verb: "unlock" | "lock", arg: string | undefined): string {
  const want =
    arg === undefined || arg === "all" ? MOUNT_KINDS : MOUNT_KINDS.filter((k) => k === arg);
  if (want.length === 0) {
    return `no such mount kind "${arg}" — ${MOUNT_KINDS.join(", ")}, all`;
  }
  for (const k of want) {
    mountUnlocks.set(k, verb === "unlock");
  }
  // The badges in the bag are the player-facing readout, so a panel left open must not go on showing the old answer.
  inventory.refresh();
  const have = mountUnlocks.list();
  return (
    `${verb === "unlock" ? "unlocked" : "locked"} ${want.join(", ")} — ` +
    `now: ${have.length ? have.join(", ") : "nothing"}`
  );
}

function devRide(arg: string | undefined, kind?: string): string {
  if (arg === "unlock" || arg === "lock") {
    return devUnlockMounts(arg, kind);
  }
  if (arg === "off") {
    if (!mount.isMounted) {
      return "not mounted";
    }
    const id = mount.beast!.species.id;
    mount.dismount();
    return `dismounted ${id}`;
  }
  if (mount.isMounted) {
    return `already riding ${mount.beast!.species.id} — /mount off first`;
  }
  if (arg) {
    const idx = roster.findIndex((p) => p.id === arg);
    if (idx < 0) {
      return `no such beast "${arg}" — ${roster.map((p) => p.id).join(", ")}`;
    }
    // BONDED ONLY: a developer surface may skip the orb wobble but not OWNERSHIP, or the console is a different game from the one probes measure. `/grant` is that door.
    if (!isOwned(roster[idx])) {
      const have = [...owned];
      return `"${arg}" is not bonded — ${have.length ? have.join(", ") : "you have bonded nothing yet"}`;
    }
    if (idx === supportIdx) {
      supportIdx = primaryIdx;
    }
    primaryIdx = idx;
    refreshVisibility();
  }
  const lead = primary();
  if (!lead) {
    return "no beast bonded — /grant <speciesId> first";
  }
  const why = mount.refusal(lead);
  if (why !== "none") {
    return `cannot mount: ${why}`;
  }
  mount.mount(lead);
  return `riding ${lead.species.id} (${lead.species.locomotion})`;
}

// Bond outright, no orb and no roll — the alternative for a probe is farming Cubloons and losing a coin flip. NOT how a player gets a beast, hence a separate word.
/** How many beasts the developer door has seated. See `devGrant`. */
let devSeated = 0;

function devGrant(arg: string | undefined, again = false): string {
  if (!arg) {
    const have = [...owned];
    return `bonded: ${have.length ? have.join(", ") : "nothing"} — of ${ALL_SPECIES.map((sp) => sp.id).join(", ")}`;
  }
  // `all` is for the probe suite, where modules each need a DIFFERENT mount. `none` releases every bond,
  // which is what a probe about EARNING one needs: a companion fights the animals a taming test stages,
  // and test-taming lost its subject two runs in five.
  if (arg === "none") {
    const had = owned.size;
    owned.clear();
    primaryIdx = -1;
    supportIdx = -1;
    devSeated = 0;
    refreshVisibility();
    inventory.refresh();
    return `released ${had} bond(s) — the party is empty`;
  }
  if (arg === "all") {
    let n = 0;
    for (const sp of ALL_SPECIES) {
      if (!ownsSpecies(sp.id) && grantBeast(sp.id) !== null) {
        n++;
      }
    }
    inventory.refresh();
    return `bonded ${n} more (${owned.size} total)`;
  }
  if (!speciesById(arg)) {
    return `no such beast "${arg}" — ${ALL_SPECIES.map((sp) => sp.id).join(", ")}`;
  }
  // ONE PER SPECIES unless asked: probes grant on every module and must not breed a pack. `again` is the
  // player's second orb — another body of the species with its own level (issue #110).
  if (!again && ownsSpecies(arg)) {
    return `"${arg}" is already bonded — /grant ${arg} again for another`;
  }
  const granted = grantBeast(arg);
  if (granted === null) {
    return `"${arg}" could not be bonded`;
  }
  // AND SEAT IT: `grantBeast` only fills an EMPTY slot, which is right in play and wrong for this door —
  // with the starter in the primary slot the second grant landed nowhere. Grants arrive in the order the
  // caller wants them SEATED: first the lead, then support.
  const idx = roster.indexOf(granted);
  if (idx !== primaryIdx && idx !== supportIdx) {
    if (devSeated === 0) {
      primaryIdx = idx;
    } else {
      supportIdx = idx;
    }
    devSeated++;
    refreshVisibility();
  }
  inventory.refresh();
  return `bonded ${granted.id} (${owned.size} total)`;
}
devConsole?.register({
  name: "mount",
  args: "[off|<speciesId>|unlock [<kind>|all]|lock [<kind>|all]]",
  help:
    "Ride the primary beast without the 2s hold; /mount off dismounts. " +
    "Riding is locked until the story unlocks it — /mount unlock opens all three kinds.",
  run: (args) => devRide(args[0], args[1]),
});
devConsole?.register({
  name: "grant",
  args: "[<speciesId> [again]|all|none]",
  help:
    "Bond a beast outright, no orb needed; `again` bonds a second body of a species you have; " +
    "/grant none releases every bond; bare /grant lists what you have.",
  run: (args) => devGrant(args[0], args[1] === "again"),
});
// TEST HOOK, and the same argument `__dbgTp` makes: it DRIVES STATE, which is a probe's job.
(window as unknown as { __dbgRide: (id?: string) => string }).__dbgRide = (id) => devRide(id);
// A DRIVER, not a reader: test-mounts must see the lock refuse and then the same hold succeed, and only a live flip shows both in one page.
(
  window as unknown as { __dbgUnlockMount: (kind?: string, on?: boolean) => string }
).__dbgUnlockMount = (kind, on = true) => devUnlockMounts(on ? "unlock" : "lock", kind);
(
  window as unknown as { __dbgGrantBeast: (id?: string, again?: boolean) => string }
).__dbgGrantBeast = (id, again = false) => devGrant(id, again);
// A DRIVER for a beast's level: two bodies of one species must come back from a save at their own levels (issue #110).
(window as unknown as { __dbgBeastXp: (id: string, xp: number) => unknown }).__dbgBeastXp = (id, xp) => {
  const b = roster.find((x) => x.id === id && isOwned(x));
  if (!b) {
    return { ok: false, why: `no bonded beast "${id}"` };
  }
  b.gainXp(xp);
  return { ok: true, id: b.id, level: b.level, xp: b.xp };
};
// A pinned flag is reported and NOT written through: a measurement run may shadow the player's choice for one load, never become it.
function setFeedbackPref(
  key: "hapticIntensity" | "shakeIntensity",
  raw: string | undefined,
  pinned: number | null,
): string {
  if (raw === undefined) {
    const at = pinned ?? loadPrefs()[key];
    return `${key} = ${at}${pinned !== null ? " (pinned by URL)" : ""}`;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    return "usage: 0..1";
  }
  savePrefs({ [key]: v });
  if (pinned !== null) {
    return `saved ${key} = ${v}, but this load is pinned to ${pinned}`;
  }
  feedback?.setOptions({ [key === "hapticIntensity" ? "hapticIntensity" : "shakeIntensity"]: v });
  return `${key} = ${v}`;
}

// The dial half of the panel's switches, writing the same keys (core/prefs.ts); `?haptics=` / `?shake=` pin a value for one load.
devConsole?.register({
  name: "haptics",
  args: "[<0..1>]",
  help: "Show or set controller rumble strength. Persists.",
  run: (args) => setFeedbackPref("hapticIntensity", args[0], flags.haptics),
});
devConsole?.register({
  name: "vibration",
  args: "[0|1]",
  help: "Show or set the controller-vibration switch. Persists. On by default.",
  run: (args) => {
    if (args[0] === undefined) {
      return `hapticFeedback = ${loadPrefs().hapticFeedback}`;
    }
    if (args[0] !== "0" && args[0] !== "1") {
      return "usage: 0 or 1";
    }
    const on = args[0] === "1";
    savePrefs({ hapticFeedback: on });
    feedback?.setOptions({ hapticFeedback: on });
    return `hapticFeedback = ${on}`;
  },
});
// The dial half of the music row: the panel offers six steps, this takes anything between. `?vol=` pins for one load.
devConsole?.register({
  name: "volume",
  args: "[<0..1>]",
  help: "Show or set music volume. Persists. 0 unloads the track entirely.",
  run: (args) => {
    if (args[0] === undefined) {
      const at = flags.volume ?? (flags.silentBoot ? 0 : loadPrefs().volume);
      const why =
        flags.volume !== null
          ? " (pinned by URL)"
          : flags.silentBoot
            ? " (muted: menu=0 / photo=1 — pass ?vol= to hear it)"
            : "";
      return `volume = ${at}${why}`;
    }
    const v = Number(args[0]);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return "usage: 0..1";
    }
    savePrefs({ volume: v });
    if (flags.volume !== null) {
      return `saved volume = ${v}, but this load is pinned to ${flags.volume}`;
    }
    // Live: this is the one preference whose effect is audible while you type.
    music.setVolume(v);
    return `volume = ${v}`;
  },
});
devConsole?.register({
  name: "shake",
  args: "[<0..1>]",
  help: "Show or set camera-shake strength. Persists.",
  run: (args) => setFeedbackPref("shakeIntensity", args[0], flags.shake),
});
devConsole?.register({
  name: "invertlook",
  args: "<x|y> [0|1]",
  help: "Show or set stick look inversion (pad and touch). Persists. Y is on by default.",
  run: (args) => {
    const axis = (args[0] ?? "").toLowerCase();
    if (axis !== "x" && axis !== "y") {
      return "usage: /invertlook <x|y> [0|1]";
    }
    const key = axis === "x" ? "invertLookX" : "invertLookY";
    const pinned = axis === "x" ? flags.invertLookX : flags.invertLookY;
    if (args[1] === undefined) {
      const at = pinned ?? loadPrefs()[key];
      return `${key} = ${at}${pinned !== null ? " (pinned by URL)" : ""}`;
    }
    if (args[1] !== "0" && args[1] !== "1") {
      return "usage: 0 or 1";
    }
    const on = args[1] === "1";
    savePrefs({ [key]: on });
    if (pinned !== null) {
      return `saved ${key} = ${on}, but this load is pinned to ${pinned}`;
    }
    // Applied live: this is the one setting you can only judge with the stick in your hand.
    const a: Partial<LookAxes> = axis === "x" ? { invertX: on } : { invertY: on };
    pad?.setLookAxes(a);
    touch?.setLookAxes(a);
    return `${key} = ${on}`;
  },
});
devConsole?.register({
  name: "zone",
  args: "[<id>]",
  help: "Show the active zone, or switch to one now (skips the gateway dwell).",
  run: (args) => {
    if (!args[0]) {
      return (
        `${zones.id} (${zones.name}) — ${zones.world.chunksLoaded} chunks, ` +
        `${zones.transitions} transition(s). Zones: ${zones.zoneIds.join(", ")}`
      );
    }
    // A forced switch builds and warms the destination synchronously — one long frame, which is the frame the preload band exists to avoid.
    return zones.switchTo(args[0]);
  },
});
devConsole?.register({
  name: "path",
  args: "<dx> <dz> [profile] [cross]",
  help: "Route a path from the hero to an offset and carve it in. Rebuilds every chunk.",
  run: (args) => {
    const dx = Number(args[0]);
    const dz = Number(args[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
      return "usage: /path <dx> <dz> [road|footpath] [cross]";
    }
    const r = world.addPath({
      from: [player.position.x, player.position.z],
      to: [player.position.x + dx, player.position.z + dz],
      profile: args[2],
      // `cross` routes THROUGH the network and merges at the first crossing (see World.addPath).
      cross: args[3] === "cross",
      refit: refitHero,
    });
    if (r.error) {
      return `refused: ${r.error}`;
    }
    const lines = [
      `${r.id}: ${r.length} units over ${r.samples} samples` + (r.note ? ` (${r.note})` : ""),
    ];
    for (const n of r.nodes) {
      lines.push(`  junction at ${n.x}, ${n.z} — ${n.arms} arms`);
    }
    // EVERY REFUSAL IS PRINTED: a merge that quietly did nothing is what issue #142 §12f forbids.
    for (const why of r.refused) {
      lines.push(`  no merge: ${why}`);
    }
    return lines.join("\n");
  },
});
devConsole?.register({
  name: "tp",
  args: "<dx> <dz>",
  help: "Move the hero by an offset, for reaching something to inspect.",
  run: (args) => {
    const dx = Number(args[0]);
    const dz = Number(args[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
      return "usage: /tp <dx> <dz>";
    }
    player.position.x += dx;
    player.position.z += dz;
    player.position.y = Math.max(
      world.getHeight(player.position.x, player.position.z),
      world.waterLevel,
    );
    return `moved to ${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)}`;
  },
});

// Fixed-timestep simulation, decoupled from the render cadence: SIM_DT slices however often we draw,
// leftover carried. The sim no longer changes shape with the display, and a backlog is replayed in
// bounded steps so nothing tunnels. At MAX_STEPS the backlog is DROPPED — a stalled tab must not
// fast-forward. It does not fix hitches (those are first-use shader compiles). `simhz=<n>` overrides.
const SIM_HZ = Math.max(20, Number(params.get("simhz") ?? 60));
const SIM_DT = 1 / SIM_HZ;
const MAX_STEPS = 4;
let simAccumulator = 0;

// One simulation slice. `first` is true only on the slice that owns this frame's input edges, since
// `pressed()` stays true all frame and a discrete action read every slice would fire twice; held state
// is deliberately not gated.
//
// Shader warm-up is THE FIX FOR THE FREEZES: a program compiles on its first DRAW, and on ANGLE/D3D the
// driver defers to the draw call, so the stall lands in the GPU process with no CPU time in it
// (measured: 14 links at 7.2 s, then a 499 ms frame). So draw one of everything now, camera parked far
// under the world. Program keys include the visible light count, so the count is walked 1..pool max.
const _warmPos = new THREE.Vector3();
const _warmQuat = new THREE.Quaternion();
const _warmStage = new THREE.Vector3();

// ONE warm-up render: park the camera on `stage`, add `lights` pool lights, draw, put it back. Split
// out because a ZONE TRANSITION needs the same work against another world and cannot afford one frame
// — ZoneManager calls this every third frame while the destination preloads. `lights` is how many to
// ADD, not a target: at boot counts accumulate 1..10, during a transition the last step's have expired.
// The sun focus moves with the camera, because the shadow frustum decides which casters get a depth pass.
function warmUpFrame(stage: THREE.Vector3, lights: number, effects = false): void {
  _warmPos.copy(engine.camera.position);
  _warmQuat.copy(engine.camera.quaternion);
  // A HIGH, WIDE view: programs do not care where the camera is, but BUFFER UPLOADS do — a geometry
  // uploads on its first DRAW, and a draw needs it inside the frustum. 250 up and 40 back frames the
  // hold's whole footprint. Honest note: this did not remove a residual ~320 ms frame past arrival, which
  // has under 10 ms of CPU in it; what fits is a major GC from the meshers' plain `number[]`.
  engine.camera.position.set(stage.x, stage.y + 250, stage.z + 40);
  engine.camera.lookAt(stage.x, stage.y, stage.z);
  engine.updateSunFocus(stage);
  if (effects) {
    combat.warmUp(stage, 0);
  }
  // A dropped shard and the effect set on every step, so their materials are drawn at every light count.
  if (!effects) {
    combat.warmUpEffects(stage);
  }
  combat.warmUpDrop(stage);
  for (let i = 0; i < lights; i++) {
    combat.warmUpLight(stage);
  }
  engine.render();
  combat.endWarmUpDrop();
  engine.camera.position.copy(_warmPos);
  engine.camera.quaternion.copy(_warmQuat);
  engine.updateSunFocus(player.position);
}

/** VFX light pool cap. The sweep below has to cover every count up to it. */
const WARM_POOL = 10;

// How many staged renders `warmUpSteps` will yield, known before it runs: the boot bar needs a denominator, and the sweep grows with the settlement plan.
function warmUpStepCount(): number {
  return WARM_POOL + world.towns.all.length + world.towns.roads.length + 1;
}

// A GENERATOR because the same sweep is driven two ways and must stay ONE sequence: the staged boot drains a few steps at a time, `menu=0`/photo in one loop.
function* warmUpSteps(): Generator<void> {
  // The camera must look at the REAL WORLD: only materials actually drawn are recompiled. Staged 400 units under the map, the 12-program burst simply moved.
  _warmStage.copy(world.spawnPoint);
  _warmStage.y += 1;

  // One of everything, drawn once. This also takes the first pool light, so the sweep starts at 1.
  warmUpFrame(_warmStage, 0, true);
  yield;

  // EXACTLY one light per pass: adding two leaves every odd count uncompiled, which recompiled twelve materials mid-fight. Nothing expires between boot steps.
  for (let i = 1; i < WARM_POOL; i++) {
    warmUpFrame(_warmStage, 1);
    yield;
  }

  // THE TOWNS AND THE ROADS: built at world creation, hundreds of units out, so the staged render never
  // draws them. Otherwise the shared GLOW program and ~100k vertices of buffer upload land on the frame
  // the player first sees the camp. One frame per site is enough: an upload is per GEOMETRY.
  for (const town of world.towns.all) {
    _warmStage.set(town.x, world.getHeight(town.x, town.z) + 1, town.z);
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

  // The two underwater programs (tint, bubbles): nothing above draws them, and the frame they would otherwise link on is the frame the hero's head goes under.
  underwater.warmUp(() => engine.render());
  yield;

  // World-owned effects, same reason: the sky island's waterfall hangs 190 up and 170 out, so no staged frame above ever drew it.
  world.warmUpEffects(() => engine.render());
  yield;

  // NOT renderer.compile(scene, camera): measured, it linked 117 programs and made boot far worse (593/429/287 ms stalls against ~110 ms), permutations and all.

  // Expire everything the warm-up spawned — each effect was given a life in hundredths of a second.
  combat.update(5, player as unknown as Damageable, []);
}

/** Drain the whole sweep now. The unstaged boot path; see `warmUpSteps`. */
function warmUpShaders(): void {
  for (const _ of warmUpSteps()) {
    /* every step, one task */
  }
}

// How close to a den's marker its prompt shows, and the height band. 3.5 is what NPC_TALK_RANGE was
// tuned against; the RISE is issue #78's half, a cylinder rather than a sphere that shortened the reach
// on slopes, at NPC_TALK_RISE's 2.5 — a hop and a hovering mount are in, a climb is out.
const SHOP_RANGE = 3.5;
const SHOP_RISE = 2.5;
/** Set by the shop-proximity test, read by the hint decision after the zone update. */
let nearShop = false;
/** The NPC in talk range this slice, or null. Same contract as `nearShop`. */
let nearNpc: NpcInfo | null = null;

// Kept per NPC because the pill is HTML with the cap inside `{key}`, so composing allocates — and it cannot be one constant, the sentence names the person.
const npcHints = new Map<string, string>();
function npcHint(npc: NpcInfo): string {
  let html = npcHints.get(npc.id);
  if (html === undefined) {
    html = t("hint.npcTalk", { key: hud.interactPrompt, name: t(npc.nameKey) });
    npcHints.set(npc.id, html);
  }
  return html;
}
/** The dialogue panel's footer. Composed like the hints above. */
let dialogueFoot = "";

// Re-compose every prompt hoisted out of the frame loop — the exhaustive list and the only writer. Two
// things invalidate them, neither per-frame: the language and the DEVICE, since each has a key cap baked
// in. The per-NPC cache goes with them: it is keyed by person.
function composeKeyHints(): void {
  const key = hud.interactPrompt;
  skillDenHint = t("hint.skillDen", { key });
  dialogueFoot = t("npc.dialogue.close", { key });
  npcHints.clear();
}
composeKeyHints();

// How far a wild beast can be and still be worth reporting: past 24 units it cannot win one of the
// sway field's six slots against the party on top of the camera, so reporting it is pure cost.
const DISTURB_RANGE2 = 24 * 24;

// Tell the world what is moving through it this slice. Composition-root policy, after the beasts have
// moved and before `zones.update` so the cost lands in the `world` section. The wild pack is one slice
// stale by construction — 16 ms against smoothing measured in hundreds.
function reportMovers(): void {
  if (!flags.props) {
    return;
  }
  const ridden = mount.beast;
  if (ridden) {
    // The saddle, not the rider: a mounted hero sits a metre up, which the clearance test reads as a hovering
    // body — a galloping boarhound blowing grass instead of trampling it.
    world.disturb(
      -1,
      ridden.position.x,
      ridden.position.y,
      ridden.position.z,
      ridden.scaledRadius,
      ridden.species.locomotion === "flying" ? "fly" : "walk",
    );
  } else {
    world.disturb(
      -1,
      player.position.x,
      player.position.y,
      player.position.z,
      player.radius,
      "walk",
    );
  }
  if (flags.beasts) {
    const p0 = primary();
    const p1 = support();
    // `inTransit` like `isDead`: a beast travelling as light has no feet down and is pinned above the hero, where a `walk` report blows a hole in the meadow.
    if (p0 && p0 !== ridden && !p0.isDead && !p0.inTransit) {
      world.disturb(
        -2,
        p0.position.x,
        p0.position.y,
        p0.position.z,
        p0.radius,
        p0.species.locomotion === "flying" ? "fly" : "walk",
      );
    }
    if (p1 && p1 !== ridden && p1 !== p0 && !p1.isDead && !p1.inTransit) {
      world.disturb(
        -3,
        p1.position.x,
        p1.position.y,
        p1.position.z,
        p1.radius,
        p1.species.locomotion === "flying" ? "fly" : "walk",
      );
    }
  }
  for (const e of combat.enemies) {
    if (!e.targetable) {
      continue;
    }
    const dx = e.position.x - player.position.x;
    const dz = e.position.z - player.position.z;
    if (dx * dx + dz * dz > DISTURB_RANGE2) {
      continue;
    }
    world.disturb(
      e.root.id,
      e.position.x,
      e.position.y,
      e.position.z,
      e.radius,
      e.species === "peckit" ? "fly" : "walk",
    );
  }
}

function simulate(dt: number, first: boolean, interactive: boolean): void {
  // An open console is a modal: it has the keyboard.
  const modal =
    hud.isShopOpen() ||
    hud.isControlsOpen() ||
    pauseMenu.isOpen ||
    inventory.isOpen ||
    journal.isOpen ||
    map.isOpen ||
    !!devConsole?.isOpen ||
    perfPanel.isTyping;
  nearShop = false;
  nearNpc = null;

  // THE SAVE CLOCK IS GAME TIME, and above the modal branch: a player reading the controls sheet has not stopped playing. On the slice, so `__dbgAdvance` drives it.
  tickAutosave(dt);
  // On the slice for the clock's reason: a quest's stage dressing is part of the world.
  tickPracticeBeast(dt);
  tickHoldStage(dt);
  tickBossStage(dt);
  tickMarketStage(dt);
  tickRookeryStage(dt);
  tickMawsStage(dt);
  tickWaypoints(dt);
  // Where he has been, for the map's fog: cheap until he crosses a cell.
  exploration.visit(zones.id, player.position.x, player.position.z);

  // THE MOVING PARTS OF THE WORLD MOVE FIRST, before anything standing on them. Not inside `zones.update`
  // deliberately: that runs at the END of a slice, so riders would spend the delta a slice late. Above the
  // `interactive` branch, so a staged capture gets the same moving world.
  world.carriers.advance(dt);
  // Whose contact the particle system tests this slice, or null: it integrates on every slice either way, so only the contact test needs someone.
  let toucher: Player | null = null;

  // A rate control, so the look delta must be injected BEFORE the camera update takes it — later, endFrame() wiped it. Per SLICE: each injects its own SIM_DT of turn.
  if (interactive && !modal) {
    touch?.update(dt);
  }

  // A hero nobody is driving is still standing on something: photo mode skips the player controller and
  // must still move him with whatever carries him. The mount answers for the pair when one is ridden, so
  // exactly one of these moves him. A modal used to be the second branch here — issue #101.
  if (!interactive) {
    mount.carryFrozen(dt);
    if (!mount.isMounted) {
      player.carry();
    }
  }

  // Photo mode drives the camera and the subject itself and must not have the player controller or the
  // HUD fighting it, but it DOES need the world to stream and the beasts to animate.
  if (!interactive) {
    // fall through to the world update
  } else {
    // A PANEL TAKES THE INPUT, NOT THE CLOCK (issue #101). Gated on `!modal`, opening any panel froze the
    // hero mid-air while the enemies below this branch went on swinging. `input.suspended` is the whole
    // claim: every gameplay read answers "nothing pressed", so a slice runs with the sticks at rest and
    // gravity, friction and a swing in flight resolve. Set for THIS BLOCK ONLY — the modal's keys follow.
    // A SAIL SUSPENDS INPUT LIKE A MODAL: the hero is on a boat the game is
    // steering, so gameplay reads answer "nothing pressed" until the fade lifts.
    input.suspended = modal || sail !== null;
    perf.section("input");
    // Mounting runs BEFORE the player: while ridden it writes his position, velocity and saddle pose for the slice. Safe every slice; the F edge is latched inside.
    mount.update(dt, flags.beasts ? primary() : null);
    player.update(dt);
    // The hero is the only thing that brushes the world today; a mount's dust would pass `mount.beast`.
    toucher = player;
    // Straight after he moves, so "walked into Redbriar" is answered from the position that put him
    // there. Two distance tests against a list of four; it needs no rate of its own.
    syncTownArrival();
    perf.section("player");

    if (first) {
      const skills = hotbarSkills();
      const lead = primary();
      (["Digit1", "Digit2", "Digit3", "Digit4"] as const).forEach((code, i) => {
        if (input.pressed(code) && lead && skills[i]) {
          castFromBeast(lead, skills[i]);
        }
      });

      // THE TAMING THROW, gated on nothing else: an orb can be thrown from the saddle, mid-air or
      // mid-fight, and every reason it might not work is a message `throwReadiedOrb` gives.
      if (input.pressed("KeyQ")) {
        throwReadiedOrb();
      }

      // Swapping is locked out in the saddle: every mounted path keys off primary() being the ridden beast,
      // so a Tab mid-ride would make "riding" and "commanding" two different animals.
      if (mount.isMounted) {
        if (input.pressed("Tab") || input.pressed("BracketLeft") || input.pressed("BracketRight")) {
          bus.emit({ type: "toast", text: t("toast.dismountFirst") });
        }
      } else {
        // Tab SWAPS the two slots, so both must be filled or a real beast would be benched into an empty one.
        if (input.pressed("Tab") && primaryIdx >= 0 && supportIdx >= 0) {
          const wasPrimary = primaryIdx;
          primaryIdx = supportIdx;
          supportIdx = wasPrimary;
          const lead2 = primary();
          if (lead2) {
            bus.emit({
              type: "toast",
              text: t("toast.beastTakesLead", { beast: t(lead2.species.nameKey) }),
            });
          }
        }
        if (input.pressed("BracketRight")) {
          cycleBeast("primary", 1);
        }
        if (input.pressed("BracketLeft")) {
          cycleBeast("support", 1);
        }
      }
    }

    const sup = support();

    fetchScanT -= dt;
    if (fetchScanT <= 0) {
      fetchScanT = FETCH_SCAN;
      if (flags.beasts && sup && !sup.isFetching && !sup.isDead) {
        const job = combat.findFetchJob(player.position, FETCH_RADIUS, worthFetching);
        if (job) {
          sup.beginFetch(job);
        }
      }
    }

    if (sup && sup.wantsSupportCast()) {
      const known = sup.knownSkillIds.map((id) => getSkill(id)).filter((s): s is SkillDef => !!s);
      const heal = known.find((s) => s.targeting === "support" || s.targeting === "self");
      const lead3 = primary();
      const hurt =
        player.hp < player.maxHp * 0.7 || (lead3 !== null && lead3.hp < lead3.maxHp * 0.7);
      const pick =
        hurt && heal
          ? heal
          : (known.find((s) => s.targeting !== "support" && s.targeting !== "self") ?? heal);
      if (pick) {
        castFromBeast(sup, pick);
      }
    }

    // Shop proximity. The prompt is decided after the zone update, because a gateway prompt has to win: it is the one with a countdown running.
    nearShop = world.shopPositions.some((s) =>
      inReach(
        s.x,
        s.y,
        s.z,
        player.position.x,
        player.position.y,
        player.position.z,
        SHOP_RANGE,
        SHOP_RISE,
      ),
    );

    // `E` talks as `E` opens a den, and the two can never both be in range, but the NPC is tested first.
    const npcField = world.npcs;
    nearNpc =
      npcField && !npcField.talking
        ? npcField.nearest(player.position.x, player.position.y, player.position.z, NPC_TALK_RANGE)
        : null;
    if (first && input.pressed("KeyE")) {
      if (npcField?.talking) {
        npcField.endTalk();
      } else if (nearNpc) {
        npcField?.talk(nearNpc.id);
      } else if (nearShop) {
        tryOpenShop();
      } else {
        // LAST, and each refuses the press itself when the hero is not standing on
        // its own pad — the pier and the arch stand in open country, so they must
        // never take a press meant for a person or a den. The pier is tested first:
        // both refuse by position, and the two never share ground.
        const atPier = sail === null ? (ferry?.atPier() ?? null) : null;
        if (atPier) {
          startSail(atPier.to);
        } else {
          zones.requestCrossing();
        }
      }
    }
    // TWO KEYS, AND THE SPLIT IS THE POINT (issue #83 follow-up): Escape CANCELS, F10 opens the menu. The
    // browser owns half of what Escape does, so a menu key it cannot touch is the fix. Every device arrives
    // here — pad Start and touch MENU tap F10, B taps Escape. `pressed`, because this is a SIMULATION slice.
    if (first && input.pressed("Escape") && npcField?.talking) {
      npcField.endTalk();
    }
    if (first && input.pressed("F10")) {
      pauseMenu.open();
    }

    // THE GAMEPLAY BLOCK ENDS HERE, and so does the suspension: everything below is the modal's own keyboard and must read the presses this block was told to ignore.
    input.suspended = false;

    if (
      modal &&
      first &&
      (input.pressed("Escape") || input.pressed("F10") || input.pressed("KeyE"))
    ) {
      // Cancel closes the TOPMOST modal, which is why this is an if/else: one press must dismiss one thing.
      // The action wheel goes FIRST and answers for itself — inside Settings Escape means "back" —
      // so `onEscape` reports whether it spent the press. A pad must keep aiming while A/X confirms.
      // F10 is a cancel in here, which is what makes it a toggle.
      const cancel = input.pressed("Escape") || input.pressed("F10");
      if (pauseMenu.isOpen) {
        if (cancel) {
          pauseMenu.onEscape();
        } else {
          pauseMenu.activate(input.lastSource === "gamepad");
        }
      } else if (inventory.isOpen) {
        // Same shape as the menu: cancel asks the panel to spend the press, X (KeyE on the pad) confirms the
        // focused control, which is what makes the inventory workable from a controller.
        if (cancel) {
          inventory.onEscape();
        } else {
          inventory.activate();
        }
      } else if (journal.isOpen) {
        // Below the inventory because `I` is gated on the other modals — the journal is one of them — so the two
        // can never both be up. The order is what it would be if they could.
        if (cancel) {
          journal.onEscape();
        } else {
          journal.activate();
        }
      } else if (map.isOpen) {
        // Its own Escape spends the press on the travel dialog first, then the panel.
        if (cancel) {
          map.onEscape();
        } else {
          map.activate();
        }
      } else if (hud.isControlsOpen()) {
        hud.closeControls();
      } else {
        hud.closeShop();
      }
    }
  }

  // Contact particles, measured in the `beasts` profiler slot; their own timing is on `__dbgTouchFx().ms`, which is finer grained than a section anyway.
  touchFx.update(dt, toucher);

  for (const [id, remaining] of cooldowns) {
    cooldowns.set(id, Math.max(0, remaining - dt));
  }
  // ...and the potion buff, on the same clock: both are durations the player is watching.
  updateBuffs(dt);

  // Beasts follow. The swim line is 1.15 below the surface; another 1.25 is a deliberate dive, and is
  // where a flying companion changes to light rather than pretending its wings work underwater.
  const deepDiving = player.isSwimming && player.position.y < world.waterLevel - 2.4;
  const owner = {
    position: player.position,
    velocity: player.velocity,
    isSwimming: player.isSwimming,
    deepDiving,
  };
  if (flags.beasts) {
    // The ridden beast is already placed and animated by mount.update(); follow steering would fight it.
    const ridden = mount.beast;
    // Is a companion WANTED this slice (see BEAM_LAND_FIGHT): a beast in transit re-forms from three times
    // as high while this stands — issue #70's "flies next to ground and gets attacked" half. One answer for
    // both, since it is a fact about the hero.
    const needed = combat.findNearestEnemy(player.position, SUPPORT_CALL_RANGE) !== null;
    const lead = primary();
    const sup = support();
    if (lead) {
      lead.supportNeeded = needed;
      if (lead !== ridden) {
        lead.update(dt, owner, "primary", roster);
      }
    }
    if (sup) {
      sup.supportNeeded = needed;
      if (sup !== ridden) {
        sup.update(dt, owner, "support", roster);
      }
    }
  }
  perf.section("beasts");

  reportMovers();

  // Streams the zone, runs the gateway rules, builds the preload. It can swap `world` out from under this slice; everything above has finished with it.
  zones.update(player.position, dt, first);
  ferry?.update(player.position, dt);
  tickSail(dt);
  perf.section("world");

  // `t()` with no placeholders is one lookup and no allocation, so hinting per slice is free — never an
  // interpolated `t(key, vars)` here. A gateway countdown outranks both.
  // The pier's offer takes the pill when nothing nearer claims it, mirroring the press order above.
  const pierOffer = sail === null ? (ferry?.atPier() ?? null) : null;
  const hint =
    portalHint ??
    (nearNpc
      ? npcHint(nearNpc)
      : nearShop
        ? skillDenHint
        : pierOffer
          ? t("hint.ferry", { place: ferryStopName(pierOffer.to), key: hud.interactPrompt })
          : null);
  if (hint) {
    hud.showHint(hint);
  } else {
    hud.hideHint();
  }

  // Free per slice (a key lookup, and the HUD compares before writing), and resolved HERE so an open talk follows a live language switch.
  const talk = world.npcs?.talking ?? null;
  if (talk) {
    hud.showDialogue(resolveText(talk.name), resolveText(talk.line), dialogueFoot);
  } else {
    hud.hideDialogue();
  }

  // A companion in transit is not a friendly: it is light, with no position an enemy could walk to. `_friendlies` is reused to stay allocation-free.
  _friendlies.length = 0;
  const fLead = primary();
  const fSup = support();
  if (fLead && !fLead.inTransit) {
    _friendlies.push(fLead);
  }
  if (fSup && !fSup.inTransit) {
    _friendlies.push(fSup);
  }
  combat.update(dt, player as unknown as Damageable, _friendlies as unknown as Damageable[]);
  perf.section("combat");
}

function frame(): void {
  // The loop OWNS ITS OWN SHUTDOWN: `exitToTitle` clears `playing` and the next frame schedules no other, so
  // nothing is torn down under a frame halfway through drawing it.
  if (!playing) {
    return;
  }
  requestAnimationFrame(frame);
  if (!engine.beginFrame()) {
    return;
  }
  perf.begin();
  const dt = engine.tick();
  dayNight.update(dt);
  engine.applyCelestial(dayNight, dt);
  world.applyCelestial(dayNight);
  const modal =
    hud.isShopOpen() ||
    hud.isControlsOpen() ||
    pauseMenu.isOpen ||
    inventory.isOpen ||
    journal.isOpen ||
    map.isOpen ||
    perfPanel.isTyping;
  // A modal does not turn the camera, and the controls sheet keeps pointer lock, so unlike the shop it
  // goes on collecting mouse delta that no slice will spend. See Input.clearLook.
  if (modal) {
    input.clearLook();
  }
  // Escape drops pointer lock on every browser — the keyboard lock only covers a FULLSCREEN document — so
  // `armRelock` puts it back when the player moves. Not while clicking, and not while Alt holds the cursor out.
  input.autoRelock = !modal && !input.down("AltLeft") && !input.down("AltRight");

  // ONCE PER RENDERED FRAME and before the slices: look delta must integrate over wall-clock like mouse
  // movement, and the edges must land before slice 0, the one `first` is true for.
  pad?.setModal(modal || !!devConsole?.isOpen);
  pad?.poll(dt);

  simAccumulator += dt;
  let steps = 0;
  while (simAccumulator >= SIM_DT && steps < MAX_STEPS) {
    // `interactive` decides whether the hero reads the input device, and photo mode is the only thing that turns it off: `frame()` waits for `beginPlay()`.
    simulate(SIM_DT, steps === 0, !photoMode);
    simAccumulator -= SIM_DT;
    steps++;
  }
  if (steps === MAX_STEPS) {
    simAccumulator = 0;
  }

  if (photoMode) {
    // `primary()` cannot be null here — the `?beast=` branch at boot put the subject in the lead slot.
    const photoBeast = params.get("beast") ? primary() : null;
    if (photoBeast) {
      const beast = photoBeast;
      const ang = (Number(params.get("a") ?? 35) * Math.PI) / 180;
      // ~40% of frame height, sized from the rig's own extents (ears, tail, wingspan), with a hard minimum: at 55° FOV anything closer than ~2.6 units distorts.
      const subject = Math.max(0.5, beast.height, beast.radius * 2.2);
      const vFov = (engine.camera.fov * Math.PI) / 180;
      const fitDist = subject / (0.4 * 2 * Math.tan(vFov / 2));
      const dist = Number(params.get("dist") ?? Math.max(2.6, fitDist));
      const midY = beast.position.y + subject * 0.5;
      const aimY = beast.position.y + subject * 0.42;

      /** Highest camera lift needed to clear terrain along the sight line. */
      const requiredLift = (px: number, pz: number, _d: number): number => {
        let need = world.getHeight(px, pz) + 0.9;
        for (let s = 1; s <= 6; s++) {
          const frac = s / 7;
          const gx = px + (beast.position.x - px) * frac;
          const gz = pz + (beast.position.z - pz) * frac;
          const clearance = world.getHeight(gx, gz) + 0.35;
          const y = aimY + (clearance - aimY) / Math.max(0.28, 1 - frac);
          if (y > need) {
            need = y;
          }
        }
        return need;
      };

      // Eye level with the subject and never far above: an unbounded lift turned blocked shots into aerial specimen photos. Step closer first, then swing the bearing.
      const ceiling = midY + subject * 1.15;
      let cx = 0,
        cz = 0,
        camY = 0;
      let bestOver = Infinity,
        bx = 0,
        bz = 0,
        by = 0;
      outer: for (const swing of [0, 0.45, -0.45, 0.9, -0.9]) {
        for (const shrink of [1, 0.85, 0.72, 0.61]) {
          const a2 = ang + swing;
          const d2 = Math.max(1.8, dist * shrink);
          const tx = beast.position.x + Math.sin(a2) * d2;
          const tz = beast.position.z + Math.cos(a2) * d2;
          const need = requiredLift(tx, tz, d2);
          const y = Math.max(midY, need);
          const over = y - ceiling;
          if (over < bestOver) {
            bestOver = over;
            bx = tx;
            bz = tz;
            by = y;
          }
          if (over <= 0) {
            cx = tx;
            cz = tz;
            camY = y;
            break outer;
          }
        }
      }
      if (camY === 0) {
        cx = bx;
        cz = bz;
        camY = Math.min(by, ceiling);
      }
      engine.camera.position.set(cx, camY, cz);
      // Aim slightly low so the subject sits at ~0.45 frame height.
      engine.camera.lookAt(beast.position.x, aimY, beast.position.z);
      // Turn the subject to face the camera, off by 20° for a 3/4 view — off the FINAL bearing, because the occlusion search above may have swung the camera.
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
        primary()?.playAction(photoAnim as never);
      }
    }
  }

  hud.setPlayerHp(player.hp, player.maxHp);
  hud.setBeasts(beastHud(primary()), beastHud(support()));
  const skillSlots: SkillSlot[] = hotbarSkills().map((def) => {
    const remaining = cooldowns.get(def.id) ?? 0;
    return { def, cooldownRemaining: remaining, ready: remaining <= 0 };
  });
  hud.setSkills(skillSlots);
  // Presentation, so not in simulate(): the strip shows where the LENS points, placed by this frame's camera. North is world -Z.
  syncQuestMarks(dt);
  engine.camera.getWorldDirection(_compassFwd);
  hud.setCompass(
    Math.atan2(_compassFwd.x, -_compassFwd.z) * (180 / Math.PI),
    player.position.x,
    player.position.z,
  );
  // Caps follow whatever the player LAST touched; returns on the first line unless the device changed. The hint pills have a cap baked in, so they ride the same edge.
  if (hud.setPadPrompts(input.lastSource === "gamepad" && pad ? pad.glyphs : null)) {
    composeKeyHints();
  }
  hud.setMountHold(mount.progress);
  hud.setMounted(
    mount.beast ? t(mount.beast.species.nameKey) : null,
    // The MODE, re-read every frame, because a water beast changes it by swimming off a beach and not by being mounted.
    mount.beast?.species.locomotion === "flying"
      ? "flying"
      : mount.isSwimming
        ? "swimming"
        : "ground",
  );
  hud.update(dt);

  // Hidden while a modal is open so it cannot be tapped through; held virtual buttons are released.
  touch?.setVisible(!modal);

  // `padActive` is part of the gate, not decoration: a player on a controller never clicks and never taps, so without it they would never be told what the controls are.
  if (!started && (input.pointerLocked || input.touchActive || input.padActive)) {
    started = true;
    // Whichever of the three it was, it was a real user gesture — what a browser requires before a page may make noise or buzz a phone.
    feedback?.unlock();
    bus.emit({
      type: "toast",
      text: t(
        input.padActive
          ? "toast.controls.gamepad"
          : touch?.isRevealed
            ? "toast.controls.touch"
            : "toast.controls.desktop",
      ),
    });
  }

  // F1 is the controls sheet and F2 the frame readout, both read HERE rather than in a slice because
  // neither is a gameplay action: a frame that drained no slice must still answer them. `takePress`, NOT
  // `pressed` — an unconsumed edge survives until a slice drains, which uncapped is two or three toggles.
  // F1 carries the `interactive` gate so photo mode renders the same picture twice; F2 is outside it,
  // because measuring a capture's frame rate is the point.
  if (!photoMode && input.takePress("F1")) {
    // POINTER LOCK IS KEPT, unlike the shop's: a sheet is READ and closed by the key that opened it, and releasing the lock made a one-key glance cost a click to undo.
    hud.toggleControls();
  }
  // Read here beside F1 for the same reason, and `takePress` stops one press toggling twice at 165 Hz.
  if (
    !photoMode &&
    input.takePress("KeyI") &&
    (inventory.isOpen || !(modal || devConsole?.isOpen))
  ) {
    inventory.toggle();
  }
  if (!photoMode && input.takePress("KeyJ") && (journal.isOpen || !(modal || devConsole?.isOpen))) {
    journal.toggle();
  }
  if (!photoMode && input.takePress("KeyM") && (map.isOpen || !(modal || devConsole?.isOpen))) {
    map.toggle();
  }
  if (input.takePress("F2")) {
    debug.toggle();
  }
  // F3 is the panel F2's numbers are FOR: deliberately not gated on photo mode and deliberately not a
  // modal — the point is watching a working frame get cheaper, and a frozen world streams nothing.
  if (input.takePress("F3")) {
    perfPanel.toggle();
  }
  // Per frame as well as on input events: opening the shop changes the answer and is no DOM event here.
  updateCursorMode();
  // Not while the spawner's search box has focus: in a text field an arrow is a caret move, Enter submits and R
  // is a letter. The field swallows them in the capture phase anyway.
  if (perfPanel.isOpen && !perfPanel.isTyping) {
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "KeyR"]) {
      if (input.takePress(code)) {
        perfPanel.onKey(code);
      }
    }
  }
  colliderView.update(dt);
  perf.section("hud");

  // AFTER every camera decision this frame and before the render: the effect keys off where the lens ends up, and a frame late is a frame of clear water at the surface.
  underwater.update(dt, world.isWater(engine.camera.position.x, engine.camera.position.z));
  engine.setFogAbsorption(underwater.fogAbsorption);
  // And how bright to grade the result — the only knob that can say so before the tone curve (see UNDER_EXPOSURE).
  engine.setExposureScale(underwater.exposureScale);
  // A block in the output pass, because it has to run AFTER the tone curve to darken a sunlit lake bed. Same three numbers as the scene half.
  engine.setUnderwater(underwater.amount, underwater.depth, underwater.clock);

  // Every cue this frame produced, played together, once: the slices only QUEUED them, and dispatching per slice is actively wrong for rumble.
  feedback?.drain(dt);

  engine.render();
  perf.section("render");
  // The map paints its seen tiles AHEAD, a slice a frame, so it opens ready rather than filling in.
  map.warm();
  perf.section("map");
  if (perf.enabled) {
    const programs = engine.renderer.info.programs?.length ?? 0;
    if (programs !== lastPrograms) {
      perf.count("programs", programs - lastPrograms);
      lastPrograms = programs;
    }
  }
  debug.update();

  // Input edges belong to the SIMULATION, not to the frame. `endFrame()` clears one-shot state only a
  // slice reads, and at 165 fps a slice lands on barely a third of frames — clearing regardless threw two
  // thirds of every press away (measured: a 30% jump hit rate). Mouse delta is a quantity to integrate:
  // dropping it scaled look sensitivity DOWN, holding it for the whole loop scaled it UP once per slice
  // (issue #37), so the camera takes it on the first slice and this is the backstop.
  if (steps > 0) {
    input.endFrame();
  }
  perf.section("overlay");
  perf.end();
}

// How long a staged boot phase may hold the main thread. Nothing else runs, so this only protects the
// page's ability to PAINT; 10 ms keeps a 60 Hz display inside its frame. A FLOOR on responsiveness, not
// a ceiling on the slice — the steps are indivisible. What it buys is the streaming phase: 1193 ms
// against 1409 ms yielding after every `zones.update`, which on a vsync display is 60 calls a second
// against ~267 stages.
const BOOT_SLICE_MS = 10;

// `warmup=0` skips it, which is how the freeze it prevents is reproduced. One slice runs FIRST so there is something to warm: enemies primed, beasts off the origin.
if (params.get("warmup") !== "0") {
  simulate(SIM_DT, true, !photoMode);
  if (loading) {
    await loading.stage("shaders");
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

// The streaming ring around spawn, drained to EMPTY before hand-over. This is what the old `MENU_FPS`
// cap was buying badly: the streamer spends its budget per rendered frame, so rendering behind the
// poster was its only way to fill the ring, at a full pass of GTAO, bloom and SMAA each time. Draining
// here costs the chunk work alone and CONVERGES. The 4096 bound is a backstop against a future streamer
// that re-queues. Only on the staged path: under `menu=0` the game must start the instant it can.
if (loading) {
  await loading.stage("terrain");
  let mark = performance.now();
  for (let i = 0; i < 4096 && world.streaming; i++) {
    // dt 0, as `switchTo` drains with: this is building, not simulating. A real dt would run the wind and water clocks and accumulate gateway dwell.
    zones.update(player.position, 0, true);
    const loaded = world.chunksLoaded;
    loading.step(loaded / Math.max(1, loaded + world.pendingChunks));
    if (performance.now() - mark >= BOOT_SLICE_MS) {
      await loading.breathe();
      mark = performance.now();
    }
  }
}

// Phase 2 is over; whether that means "play now" or "wait for New Game" is `beginPlay`'s handshake.
prepDone = true;
loading?.complete();
beginPlay();

// So the numbers in `STAGES` (ui/loading.ts) can be re-measured. `playing` is test-menu's assertion: the frame loop must NOT run while the poster is up.
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

// WHAT CONTENT IS LOADED, WHAT IT SAYS, AND WHAT IS WRONG WITH IT — read-only and structuredClone-safe
// so tools/q.mjs can read it. Four questions, because a content bug can be at four depths: `packages`
// is what loaded and who holds it open (a lease list, so a leak reads as "`zone` still holds this"),
// `assets` is what came out, `diagnostics` every finding worst first, and `resolved` the same question
// from the world's end — an id in `assets` and not in `resolved` was refused. `state` is the save payload.
(window as unknown as { __dbgContent: () => unknown }).__dbgContent = () => {
  const byType: Record<string, number> = {};
  for (const type of ["town", "npc", "biome", "enemy", "quest", "music"]) {
    byType[type] = content.all(type).length;
  }
  return {
    ok: contentBoot.ok,
    // What loading and validating the core package cost, ms: 2.4 / 2.5 / 2.3 against a ~390 ms world stage,
    // which is why it has no chip. It also caught the provider reached through a chunk fetch (15.8 ms).
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
    // What reached the WORLD, from the world's own objects rather than the registry — which is the only way this
    // can disagree with `assets`, and disagreeing is what it is for.
    resolved: {
      towns: world.towns.all.map((tn) => tn.id),
      npcs: (world.npcs?.all ?? []).map((n) => n.id),
      enemies: enemySpecies().map((e) => e.id),
    },
    state: content.state.toJSON(),
  };
};

// What the cached static shadow map is doing — whether it is on, how big the box is, and the number the whole
// feature is about: FRAMES PER REBUILD. See core/shadow-cache.ts.
(window as unknown as { __dbgShadows: () => unknown }).__dbgShadows = () => engine.shadowDebug();

// The write half is a TEST HOOK like `__dbgTp`: a probe cannot type at the console, and the assertion is a before/after of the same chunks. Same listener `/nature` uses.
(window as unknown as { __dbgNature: () => unknown }).__dbgNature = () => {
  // THE CENSUS IS THE ASSERTION: a snapshot proves only that the table stored it, so the prop meshes' vertex counts are reported beside it, read off the scene.
  let chunks = 0;
  let props = 0;
  let grass = 0;
  engine.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.name.startsWith("chunk:")) {
      return;
    }
    const n = m.geometry.getAttribute("position")?.count ?? 0;
    if (m.name === "chunk:terrain") {
      chunks++;
    } else if (m.name === "chunk:props") {
      props += n;
    } else if (m.name === "chunk:grass") {
      grass += n;
    }
  });
  return { ...nature.snapshot(), census: { chunks, propVerts: props, grassVerts: grass } };
};
(window as unknown as { __dbgDistantTerrain: () => unknown }).__dbgDistantTerrain = () =>
  world.debugDistantTerrain();
(
  window as unknown as {
    __dbgSetNature: (id: string, value: number, area?: string) => unknown;
  }
).__dbgSetNature = (id, value, area) => {
  if (!NATURE_PARAMS.some((p) => p.id === id)) {
    return null;
  }
  if (area === undefined) {
    nature.setBase(id as NatureParamId, value);
  } else {
    nature.setArea(area as NatureAreaId, id as NatureParamId, value);
  }
  return nature.snapshot();
};

/** A/B the cache inside one page load; see `Engine.setShadowCacheEnabled`. */
(window as unknown as { __dbgShadowCache: (on: boolean) => void }).__dbgShadowCache = (on) =>
  engine.setShadowCacheEnabled(on);

// Read-only: driving the interaction is the keyboard's job, and a probe that could start a talk would
// test a path the player never takes. `ground` and `feet` check he stands ON the camp floor, not in it.
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
    escorting: world.npcs?.escorting(n.id) ?? false,
    x: +n.x.toFixed(2),
    y: +n.y.toFixed(2),
    z: +n.z.toFixed(2),
    ground: +world.getHeight(n.x, n.z).toFixed(2),
    town: world.towns.nearest(n.x, n.z)?.id ?? null,
    fromTownCentre: ((): number => {
      const t0 = world.towns.nearest(n.x, n.z);
      return t0 ? +Math.hypot(t0.x - n.x, t0.z - n.z).toFixed(2) : -1;
    })(),
    // HORIZONTAL, with the height beside it, because one slant distance cannot show which refused. `abovePlayer` is negative over him — issue #25, measured at -36.92.
    fromPlayer: +Math.hypot(n.x - player.position.x, n.z - player.position.z).toFixed(2),
    abovePlayer: +(n.y - player.position.y).toFixed(2),
    // What the shipped query answers RIGHT NOW, run rather than re-derived, so a rule change shows here.
    inTalkRange:
      world.npcs?.nearest(player.position.x, player.position.y, player.position.z, NPC_TALK_RANGE)
        ?.id === n.id,
  })),
});

// THE MOVING PARTS OF THE WORLD, and who is standing on them — what test-carrier asserts on. A pose is
// easy to read off the scene and ATTACHMENT is not, and "the hero is where he was on the deck" is the
// feature. So `onDeck` is the hero in the frame's OWN coordinates; `dyaw` is what the turn publishes;
// `ceiling` decides whether the island is reachable at all. Allocates, so never from the frame loop.
(window as unknown as { __dbgCarriers: () => unknown }).__dbgCarriers = () => ({
  ceiling: (() => {
    const c = world.carriers.ceilingAt(player.position.x, player.position.z);
    return Number.isFinite(c) ? +c.toFixed(2) : null;
  })(),
  riding: world.carriers.at(player.position.x, player.position.y, player.position.z)?.id ?? null,
  all: world.carriers.all.map((c) => {
    // World -> the frame's own axes, THROUGH THE CONTRACT: `toLocal` is on `CarrierInfo` because the save wants
    // it too (issue #171), so the copy that could drift from it is gone.
    const onDeck = { x: 0, z: 0 };
    c.toLocal(player.position.x, player.position.z, onDeck);
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
        const top = c.topAt(player.position.x, player.position.z);
        return Number.isFinite(top) ? +top.toFixed(2) : null;
      })(),
      // The MASS in this column: turf and keel, null off the footprint. `surface` is not `deckTop`; this is the pair a body cannot be between (issue #80).
      surface: (() => {
        const d = c.deckAt(player.position.x, player.position.z);
        return Number.isFinite(d) ? +d.toFixed(2) : null;
      })(),
      keel: (() => {
        const b = c.bottomAt(player.position.x, player.position.z);
        return Number.isFinite(b) ? +b.toFixed(2) : null;
      })(),
      onDeck: {
        x: +onDeck.x.toFixed(3),
        y: +(player.position.y - c.y).toFixed(3),
        z: +onDeck.z.toFixed(3),
      },
    };
  }),
});

// The carried island's waterfall. The counters are the effect's; `meshOriginY` / `meshMinY` are the
// ROCK's, and prove it did not move when forty courses of waterfall came out of it — the first must
// equal `meshMinY * cell` and the second still be the keel's depth. Null with no carried island.
(window as unknown as { __dbgSkyFall: () => unknown }).__dbgSkyFall = () => world.debugSkyFall();

// The wood on a carried deck, and whether it blocks: every planted tree with the collision query's
// answer, plus a control sweep, because "something solid here" needs "and not everywhere". Both in ONE
// evaluation, since a carrier moves a unit a second. `rise` is off the deck plane, not an altitude.
(window as unknown as { __dbgCarriedWood: () => unknown }).__dbgCarriedWood = () => {
  const c = world.carriers.all[0];
  if (!c) {
    return { deck: null, trees: [], sampled: 0, raised: 0 };
  }
  const trees = world.debugCarriedTrees().map((tree) => ({
    x: +tree.x.toFixed(2),
    z: +tree.z.toFixed(2),
    rise: +(c.topAt(tree.x, tree.z) - c.y).toFixed(2),
  }));
  let sampled = 0;
  let raised = 0;
  const step = c.radius / 12;
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      const top = c.topAt(c.x + i * step, c.z + j * step);
      if (top === -Infinity) {
        continue;
      }
      sampled++;
      // A whole unit over the turf, well above `MAX_STEP_UP`, so this counts obstacles not doorsteps.
      if (top > c.y + 1) {
        raised++;
      }
    }
  }
  return { deck: +c.y.toFixed(2), trees, sampled, raised, streets: world.debugCarriedStreets() };
};

// The journal, its tracker and the quest marks, for test-journal and test-quest-marks. `model` is what
// the panel was handed and `panel` what reached the DOM, so "model right, screen empty" is
// distinguishable; `marked` is the POLICY and `drawn` what survived the distance cull.
(window as unknown as { __dbgQuestMarks: () => unknown }).__dbgQuestMarks = () => ({
  marked: {
    npcs: [...markedNpcs]
      .map(([id, kind]) => ({ id, kind }))
      .toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    enemies: [...markedEnemies].toSorted(),
    beasts: [...markedBeasts].toSorted(),
  },
  drawn: questMarkSpots.slice(0, questMarkCount).map((s) => ({
    kind: s.kind,
    x: +s.x.toFixed(2),
    y: +s.y.toFixed(2),
    z: +s.z.toFixed(2),
  })),
});

// THE MAP: the live view, marker counts and every travel target's screen position,
// so a probe can aim a real click. `marker` is the planted flag with its zone.
(window as unknown as { __dbgMap: () => unknown }).__dbgMap = () => ({
  ...(map.debug() as Record<string, unknown>),
  planted: playerMarker,
  explored: exploration.cells(zones.id).size,
});
(window as unknown as { __dbgMapPixel: (x: number, y: number) => unknown }).__dbgMapPixel = (
  x,
  y,
) => map.pixelAt(x, y);

(window as unknown as { __dbgJournal: () => unknown }).__dbgJournal = () => ({
  open: journal.isOpen,
  tab: journal.isOpen ? journal.activeTab : null,
  model: journalModel().entries.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    tab: e.tab,
    onHud: e.onHud,
    objectives: e.objectives.map((o) => ({ text: o.text, have: o.have, need: o.need })),
    rewards: e.rewards.map((r) => `${r.label}=${r.value}`),
  })),
  panel: journal.isOpen
    ? {
        cards: Iterator.from(document.querySelectorAll(".bs-journal .q"))
          .map((q) => (q as HTMLElement).dataset.quest ?? "")
          .toArray(),
        tabs: document.querySelectorAll(".bs-journal .chip.tab").length,
        steps: document.querySelectorAll(".bs-journal .steps li").length,
        stepsDone: document.querySelectorAll(".bs-journal .steps li.ok").length,
        rewards: document.querySelectorAll(".bs-journal .bs-chip").length,
        hudButtons: document.querySelectorAll(".bs-journal [data-hud]").length,
        hudOn: document.querySelectorAll(".bs-journal [data-hud].on").length,
        empty: !!document.querySelector(".bs-journal .none"),
      }
    : null,
  hud: {
    quests: Iterator.from(document.querySelectorAll(".bs-quests .qt-n"))
      .map((n) => n.textContent ?? "")
      .toArray(),
    steps: document.querySelectorAll(".bs-quests .qt-s span").length,
  },
});

// Stage a quest so the probe has something to read: `core` ships none, and this takes the `debug` lease
// `/content load` takes. A DRIVER, not a reader — it does what talking to the giver would.
(
  window as unknown as {
    __dbgQuestStage: (pkg?: string) => Promise<unknown>;
  }
).__dbgQuestStage = async (pkg = "example-quest") => {
  const r = await content.load(pkg, "debug");
  // THE PACKAGE'S OWN QUESTS AND NOT EVERY LOADED ONE. That was the same set until the campaign began
  // loading at boot (issue #143), after which a probe asking for one quest was handed Act 1 as well.
  const ids = r.assets.filter((id) => content.get<QuestData>(id)?.type === "quest");
  for (const id of ids) {
    content.state.setQuestStatus(id, "active");
  }
  return { loaded: r.loaded, assets: r.assets, quests: ids };
};

/** Flip a quest's HUD switch the way the journal's button does. */
(
  window as unknown as {
    __dbgJournalHud: (id: string) => boolean;
  }
).__dbgJournalHud = (id) => {
  content.state.setFlag(hudFlag(id), questOnHud(id));
  return questOnHud(id);
};

// `attackStat` is what makes the gear slot testable at all — an icon looks identical whether or not
// equipping did anything — and `panel` reports the DOM, so a right model and an empty screen differ.
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
    // A gear slot carries its ROW now, actions and all: what is in one is no longer on the wall as well
    // (issue #116), so `entries` is not where a probe finds what an equipped thing offers.
    gear: m.gear.map((g) => ({
      slot: g.slot,
      id: g.entry?.id ?? null,
      kind: g.entry?.kind ?? null,
      count: g.entry?.count ?? 0,
      actions: g.entry?.actions ?? [],
    })),
    bag: bag.entries().map((e) => ({ id: e.def.id, kind: e.def.kind, count: e.count })),
    // What the host believes about the three unlocks; `panel.mountBadges` is the DOM's answer, and the pair separates a wrong model from a badge that is not drawing it.
    mounts: m.mounts,
    entries: m.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      count: e.count,
      equipped: !!e.equipped,
      actions: e.actions ?? [],
      // WHICH CELL, so a probe can assert a drag moved a box and not merely that the panel redrew (#116).
      slot: e.slot ?? -1,
    })),
    // Nulls when the panel is shut. `portraits` counts slots whose picture the 3D stage has BAKED, the only way to tell ten models from ten coloured blobs.
    panel: inventory.isOpen
      ? {
          slots: document.querySelectorAll(".bs-inv .slot").length,
          // The wall is a FIXED 11x3 of real cells, so "rows the player owns" and "boxes drawn" are two different numbers (see INV_COLS).
          filled: document.querySelectorAll(".bs-inv .slot:not(.empty)").length,
          gearSlots: document.querySelectorAll(".bs-inv .gs").length,
          tabs: document.querySelectorAll(".bs-inv .chip.tab").length,
          // THE WHOLE PANEL and not just the wall: since issue #116 a gear slot is the only place an equipped weapon or a beast walking with you is drawn at all.
          icons: document.querySelectorAll(".bs-inv .ic:not(.blob)").length,
          portraits: document.querySelectorAll(".bs-inv .ic.beast:not(.blob)").length,
          stageGl: !!document.querySelector(".bs-inv canvas.stage-gl"),
          // A ROW IS IN HAND, read off the ghost tile the panel draws under the cursor — the same thing the player sees.
          carrying: !!document.querySelector(".bs-inv .drag-ghost"),
          // WHO IS ACTUALLY IN THE STAGE'S SCENE, not who was asked for.
          stageCast: inventory.stageCast(),
          footActions: Iterator.from(document.querySelectorAll(".bs-inv .sel button"))
            .map((b) => (b as HTMLElement).dataset.do ?? "")
            .toArray(),
          tip: document.querySelector(".bs-inv .tip.on")?.textContent ?? null,
          // THE MOUNT BADGES as the DOM has them — `mounts` above is what the host believes, and reading the
          // same answer twice would prove nothing. What this catches is a badge drawn without its lit state.
          mountBadges: Iterator.from(document.querySelectorAll(".bs-inv .mt"))
            .map((b) => ({
              kind: (b as HTMLElement).dataset.tip ?? "",
              on: b.classList.contains("on"),
            }))
            .toArray(),
          selected:
            (document.querySelector(".bs-inv .slot.sel") as HTMLElement | null)?.dataset.sel ??
            null,
        }
      : null,
  };
};

// `weapon` is read off the RIG, the only copy, so it cannot report a sword while a bow is drawn. The projectile pool is shared, so the `arrow` flag is the whole claim.
(window as unknown as { __dbgShots: () => unknown }).__dbgShots = () => ({
  weapon: player.weapon,
  attackStat: player.attackStat,
  shots: combat.projectileSnapshot(),
});

// TEST HOOKS: stage a bag state and press a button without farming a 1-in-25 drop.
(window as unknown as { __dbgGive: (id: string, n?: number) => void }).__dbgGive = (id, n = 1) => {
  if (isKnownItem(id)) {
    giveItemFromContent(id, n);
  }
};

/** Drive one inventory button without a click, for the probe. */
(window as unknown as { __dbgInvAction: (id: string, action: string) => void }).__dbgInvAction = (
  id,
  action,
) => {
  inventoryAction(id, action as InvAction);
  // The panel re-reads after a button it pressed itself; this hook goes straight to the handler, so it
  // owes the screen the same refresh or a probe reads a panel one action behind the state.
  inventory.refresh();
};

(window as unknown as { __dbgTowns: () => unknown }).__dbgTowns = () => ({
  spawn: {
    x: +world.spawnPoint.x.toFixed(2),
    y: +world.spawnPoint.y.toFixed(2),
    z: +world.spawnPoint.z.toFixed(2),
  },
  // The boxes /show-colliders draws, counted. The assertion is about the registry: a town reporting zero is one whose builder was missed.
  structures: ((): unknown => {
    const b: number[] = [];
    world.debugStructures(b);
    // BANDED IN HEIGHT: a carried settlement flying over a ground one lands inside its radius and would
    // be counted as its colliders. `y` is the town's own level, so a carried town bands around its deck.
    const within = (x: number, y: number, z: number, r: number): number => {
      let n = 0;
      for (let i = 0; i < b.length; i += 6) {
        if (Math.abs(b[i + 5] - y) > 60) {
          continue;
        }
        if (Math.hypot(b[i] - x, b[i + 1] - z) <= r) {
          n++;
        }
      }
      return n;
    };
    return {
      boxes: b.length / 6,
      // The CENTRE travels with the count so a probe can aim at a settlement without pinning a seed's coordinates.
      perTown: world.towns.all.map((town) => ({
        id: town.id,
        x: +town.x.toFixed(2),
        y: +town.y.toFixed(2),
        z: +town.z.toFixed(2),
        radius: +town.outerRadius.toFixed(2),
        // A carried town rides moving world and has no chunk foliage under it — see TownRecord.carried.
        carried: town.carried,
        boxes: within(town.x, town.y, town.z, town.radius + 4),
      })),
    };
  })(),
  // THE ROAD FURNITURE AS A MEASUREMENT (issue #15): the smallest gap between two pieces, and how far
  // INSIDE the nearest carriageway any stands. A lamp interval is 26, so the closest pair should be a good
  // fraction of it. From the RIM, PER ROAD — "within 5 of a centreline" called a fingerpost 3.43 from a
  // 3.6-unit trail furniture in the road.
  furniture: ((): unknown => {
    const f = world.debugFurniture();
    // How far inside the nearest carriageway (x, z) stands: positive on the gravel, negative by its clearance when beside it.
    const roadDist = (x: number, z: number): number => {
      let best = -Infinity;
      for (const r of world.towns.roads) {
        for (let i = 3; i < r.path.length; i += 3) {
          // Point-to-segment, the same test the network's own clearance runs.
          const ax = r.path[i - 3];
          const az = r.path[i - 1];
          const dx = r.path[i] - ax;
          const dz = r.path[i + 2] - az;
          const l2 = dx * dx + dz * dz;
          let u = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          if (u < 0) {
            u = 0;
          } else if (u > 1) {
            u = 1;
          }
          const d = r.deckEdge - Math.hypot(ax + dx * u - x, az + dz * u - z);
          if (d > best) {
            best = d;
          }
        }
      }
      return best;
    };
    let closestPair = Infinity;
    let pairAt: { x: number; z: number } | null = null;
    for (let i = 0; i < f.length; i++) {
      for (let k = i + 1; k < f.length; k++) {
        const d = Math.hypot(f[i].x - f[k].x, f[i].z - f[k].z);
        if (d < closestPair) {
          closestPair = d;
          pairAt = { x: +f[i].x.toFixed(1), z: +f[i].z.toFixed(1) };
        }
      }
    }
    let onRoad = 0;
    let nearestRoad = Infinity;
    let roadAt: { x: number; z: number } | null = null;
    for (const p of f) {
      const d = roadDist(p.x, p.z);
      if (d > 0) {
        onRoad++;
      }
      if (-d < nearestRoad) {
        nearestRoad = -d;
        roadAt = { x: +p.x.toFixed(1), z: +p.z.toFixed(1) };
      }
    }
    return {
      count: f.length,
      lamps: f.filter((p) => p.kind === "lamp").length,
      posts: f.filter((p) => p.kind === "post").length,
      closestPair: Number.isFinite(closestPair) ? +closestPair.toFixed(2) : null,
      closestPairAt: pairAt,
      /** How clear of the nearest RIM the nearest piece is. Negative is on it. */
      nearestRoad: Number.isFinite(nearestRoad) ? +nearestRoad.toFixed(2) : null,
      nearestRoadAt: roadAt,
      onCarriageway: onRoad,
    };
  })(),
  // In this hook because it answers the same class of question about the same pass, and issue #105's invariant
  // is numbers; test-fence runs the identical check on the lab demos.
  fences: world.debugFences(),
  // The fence kit's own metrics, so a probe checks a chain against what the BUILDER painted rather than a copy of those numbers in a test.
  fenceKit: {
    postH: FENCE_POST_H,
    postR: FENCE_POST_R,
    postWidth: FENCE_POST_WIDTH,
    railAt: [...FENCE_RAIL_AT],
    railWidth: FENCE_RAIL_WIDTH,
    railHeight: FENCE_RAIL_HEIGHT,
  },
  towns: world.towns.all.map((town) => ({
    id: town.id,
    // The looked-up name, so `?lang=sv` shows what the fingerpost shows; field names stay English.
    name: t(town.nameKey),
    kind: town.kind,
    // The resolved TownInfo.color — the compass chips that used to expose it are gone (issue #247).
    color: town.color,
    // Whether something is carrying it: a carried town's colliders are in its carrier's frame and its position is a reading rather than a placement.
    carried: town.carried,
    x: +town.x.toFixed(1),
    y: town.y,
    z: +town.z.toFixed(1),
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
      // Sample the walking surface finely: a step is a property of the surface between the deck samples.
      const steps = Math.max(1, Math.ceil(seg / 0.25));
      for (let k = 1; k <= steps; k++) {
        const frac = k / steps;
        const x = ax + (bx - ax) * frac;
        const z = az + (bz - az) * frac;
        const h = world.getHeight(x, z);
        const rise = h - prevH;
        if (rise > maxStep) {
          maxStep = rise;
        }
        const g = Math.abs(rise) / (seg / steps);
        if (g > maxGrade) {
          maxGrade = g;
        }
        prevH = h;
      }
      if (r.bridge[i - 1]) {
        spans.push({
          x: +ax.toFixed(1),
          z: +az.toFixed(1),
          y: +r.path[(i - 1) * 3 + 1].toFixed(2),
        });
      }
    }
    return {
      id: r.id,
      from: r.from,
      to: r.to,
      /** Which KIND of path, and how wide — see `test-road.mjs`'s sweep. */
      profile: r.profile,
      deckEdge: r.deckEdge,
      /** 0 is a role, not an omission — the litter probe holds it to zero. */
      litter: r.litter,
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

// The dens are the one class of building not in the town registry, so `__dbgTowns` cannot find them.
(
  window as unknown as {
    __dbgShops: () => Array<Record<string, number>>;
  }
).__dbgShops = () =>
  world.shopPositions.map((p) => ({
    x: +p.x.toFixed(2),
    y: +p.y.toFixed(2),
    z: +p.z.toFixed(2),
    facing: +Math.atan2(world.spawnPoint.x - p.x, world.spawnPoint.z - p.z).toFixed(3),
    distToSpawn: +p.distanceTo(world.spawnPoint).toFixed(2),
  }));

// A keep-out fails INVISIBLY, so telling working zones from a broken spawner means reading the discs and then asking `blocks` about a point — hence the optional column.
(
  window as unknown as {
    __dbgSafeZones: (x?: number, z?: number) => unknown;
  }
).__dbgSafeZones = (x, z) => ({
  zones: world.safeZones.all.map((s) => ({
    id: s.id,
    x: +s.x.toFixed(2),
    z: +s.z.toFixed(2),
    radius: +s.radius.toFixed(2),
  })),
  towns: world.towns.all.map((town) => ({
    id: town.id,
    radius: town.radius,
    outerRadius: +town.outerRadius.toFixed(2),
    noSpawnRadius: +town.noSpawnRadius.toFixed(2),
  })),
  blocks: x === undefined || z === undefined ? null : world.safeZones.blocksSpawn(x, z),
});

// `__dbgTowns().roads` is the DRAWN paths only, so beaten tracks were invisible after issue #142 folded them
// onto the same network; the `edge` pair is that fold's invariant.
(
  window as unknown as {
    __dbgPaths: (x?: number, z?: number) => unknown;
  }
).__dbgPaths = (x, z) => world.debugPaths(x, z);

// Show/hide every drawn ribbon inside one page load: `test-road-fade` proves the
// horizon dissolve by what this toggle changes near against far.
(
  window as unknown as {
    __dbgPathRibbons: (on: boolean) => boolean;
  }
).__dbgPathRibbons = (on) => world.debugPathRibbons(on);

// The scriptable half of `/path`, which is why issue #142 §12 is testable before a panel exists. Both share
// `World.addPath` and `refit`, so a probe cannot pass what the UI fails.
(
  window as unknown as {
    __dbgAddPath: (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      profile?: string,
      cross?: boolean,
    ) => unknown;
  }
).__dbgAddPath = (ax, az, bx, bz, profile, cross) =>
  world.addPath({
    from: [ax, az],
    to: [bx, bz],
    profile,
    cross,
    refit: refitHero,
  });

// `ground` blocks and supports, `trunkSolidTop` is the bole a tree adds, `structureTop` what a
// settlement built, `climbTop` what can be grabbed — deliberately not a building, which you would climb over.
(window as unknown as { __dbgWorld: (x: number, z: number) => unknown }).__dbgWorld = (x, z) => ({
  ground: world.getHeight(x, z),
  climbTop: world.climbTopAt(x, z),
  trunkSolidTop: world.trunkSolidTopAt(x, z),
  structureTop: world.structureTopAt(x, z),
  // The two WET queries, added with the deep sea (issue #76), separate for the same reason: deriving
  // "is this deep" from `ground` would hard-code a threshold the world owns (DEEP_WATER_DEPTH).
  water: world.isWater(x, z),
  deep: world.isDeepWater(x, z),
  /** How walked this column is, 0..1 — see `World.debugWear`. */
  wear: +world.debugWear(x, z).toFixed(6),
  /** What the MESHER draws here, against `ground` which is what you stand on. */
  column: +world.debugColumn(x, z).toFixed(3),
});

// What you SEE at a column, as opposed to what you STAND ON: this raycasts the scene straight down,
// where `ground` is the walking surface. The two disagreeing is a nasty bug — the hero is where physics
// says and looks buried — and no other test can see it, since they compare the world with itself. The
// ray starts just over the walking surface: from 400 it would report the cloud deck and every eave.
const _surfRay = new THREE.Raycaster();
// EVERY LAYER, and not optional since core/shadow-cache.ts moved the world's static geometry onto a
// layer of its own: a Raycaster starts on layer 0 alone and would fire straight through the terrain.
_surfRay.layers.enableAll();
const _surfFrom = new THREE.Vector3();
const _surfDown = new THREE.Vector3(0, -1, 0);
(
  window as unknown as {
    __dbgSurfaceY: (x: number, z: number, above?: number) => unknown;
  }
).__dbgSurfaceY = (x, z, above = 3) => {
  const ground = world.getHeight(x, z);
  _surfFrom.set(x, ground + above, z);
  _surfRay.set(_surfFrom, _surfDown);
  _surfRay.far = above + 40;
  // Sprite.raycast reads `raycaster.camera.matrixWorld` and throws on a null one, and the world is full of glow sprites.
  _surfRay.camera = engine.camera;
  // MESHES ONLY: a ray fired through this world also collects glow sprites and drifting mote Points, and left in, they were all this reported.
  const hits = _surfRay
    .intersectObject(engine.scene, true)
    .filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
  const top = hits[0] ?? null;
  return {
    ground: +ground.toFixed(3),
    surface: top ? +top.point.y.toFixed(3) : null,
    hit: top ? top.object.name || top.object.type : null,
    /** How far a figure standing on `ground` is buried by what is drawn. */
    sink: top ? +(top.point.y - ground).toFixed(3) : null,
    hits: hits.slice(0, 4).map((h) => ({
      y: +h.point.y.toFixed(3),
      name: h.object.name || h.object.type,
    })),
  };
};

/**
 * WHAT IS DRAWN AT A COLUMN, for tens of thousands of columns.
 *
 * `__dbgSurfaceY` above answers this for ONE column and costs 4.2 ms, because
 * it walks the whole scene graph and then brute-forces the triangles of every
 * terrain mesh it did not reject. The road guard wants ~35,000 columns, which
 * is four minutes of raycasting for a question that has a much cheaper shape:
 * THE RAY IS ALWAYS STRAIGHT DOWN. A vertical ray through a triangle is a
 * point-in-triangle test in 2D plus one barycentric lift, so the whole sweep
 * needs a flat index rather than a raycaster.
 *
 * So: bucket every triangle of the matching meshes into a 2D grid ONCE, then
 * answer each column from the handful of triangles over it. Build is linear in
 * the world's triangles and is amortised across the sweep that follows.
 *
 * It is NOT a general replacement for `__dbgSurfaceY` — it only knows meshes
 * whose name matches, and it only fires downward. That is exactly the road
 * guard's question and deliberately not a raycaster.
 */
interface SurfaceIndex {
  pattern: string;
  cell: number;
  /** Cell key -> triangle ordinals (index into `tri` / `owner`). */
  grid: Map<number, number[]>;
  /** 9 world-space floats per triangle. */
  tri: Float64Array;
  owner: Int32Array;
  names: string[];
  triangles: number;
}
let _surfIndex: SurfaceIndex | null = null;
const _surfCellKey = (cx: number, cz: number): number => cx * 73856093 + cz * 19349663;

(
  window as unknown as {
    __dbgSurfaceIndex: (namePattern: string, cell?: number) => unknown;
  }
).__dbgSurfaceIndex = (namePattern, cell = 2) => {
  const want = new RegExp(namePattern);
  const names: string[] = [];
  const pos: number[] = [];
  const owner: number[] = [];
  const v = new THREE.Vector3();
  engine.scene.updateMatrixWorld(true);
  engine.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !o.visible || !want.test(o.name)) {
      return;
    }
    const nameId = names.push(o.name || o.type) - 1;
    const g = m.geometry;
    const p = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        v.fromBufferAttribute(p, vi).applyMatrix4(o.matrixWorld);
        pos.push(v.x, v.y, v.z);
      }
      owner.push(nameId);
    }
  });
  const tri = new Float64Array(pos);
  const grid = new Map<number, number[]>();
  for (let ti = 0; ti < owner.length; ti++) {
    const o = ti * 9;
    const minX = Math.min(tri[o], tri[o + 3], tri[o + 6]);
    const maxX = Math.max(tri[o], tri[o + 3], tri[o + 6]);
    const minZ = Math.min(tri[o + 2], tri[o + 5], tri[o + 8]);
    const maxZ = Math.max(tri[o + 2], tri[o + 5], tri[o + 8]);
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
      for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz++) {
        const k = _surfCellKey(cx, cz);
        let b = grid.get(k);
        if (!b) {
          grid.set(k, (b = []));
        }
        b.push(ti);
      }
    }
  }
  _surfIndex = {
    pattern: namePattern,
    cell,
    grid,
    tri,
    owner: new Int32Array(owner),
    names,
    triangles: owner.length,
  };
  return { meshes: names.length, triangles: owner.length, cells: grid.size, cell };
};

/**
 * A ROW of columns answered from the index, topmost `k` surfaces each — the
 * same stack `__dbgSurfaceY` returns in `hits`, which is what the cross-section
 * pass reads to tell a ribbon, the near ground and the clipmap apart at one
 * column. Flat parallel arrays because the caller reduces them in the page.
 *
 * `ground` is still `world.getHeight`, so "drawn against walked" is unchanged.
 */
(
  window as unknown as {
    __dbgSurfaceRow: (
      x0: number,
      z0: number,
      dx: number,
      dz: number,
      n: number,
      k?: number,
    ) => unknown;
  }
).__dbgSurfaceRow = (x0, z0, dx, dz, n, k = 4) => {
  const ix = _surfIndex;
  if (!ix) {
    throw new Error("__dbgSurfaceRow: call __dbgSurfaceIndex(pattern) first");
  }
  const ground = new Float64Array(n);
  const hitY = new Float64Array(n * k).fill(Number.NaN);
  const hitName = new Int32Array(n * k).fill(-1);
  const count = new Int32Array(n);
  const ys: number[] = [];
  const os: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + dx * i;
    const z = z0 + dz * i;
    ground[i] = world.getHeight(x, z);
    const bucket = ix.grid.get(_surfCellKey(Math.floor(x / ix.cell), Math.floor(z / ix.cell)));
    if (!bucket) {
      continue;
    }
    ys.length = 0;
    os.length = 0;
    for (const ti of bucket) {
      const o = ti * 9;
      const ax = ix.tri[o];
      const ay = ix.tri[o + 1];
      const az = ix.tri[o + 2];
      const bx = ix.tri[o + 3];
      const by = ix.tri[o + 4];
      const bz = ix.tri[o + 5];
      const cx = ix.tri[o + 6];
      const cy = ix.tri[o + 7];
      const cz = ix.tri[o + 8];
      // Barycentric in the XZ plane; a degenerate triangle (seen edge-on from
      // above) has zero area there and cannot be under the column at all.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d === 0) {
        continue;
      }
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      if (wa < 0 || wa > 1) {
        continue;
      }
      const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (wb < 0 || wb > 1) {
        continue;
      }
      const wc = 1 - wa - wb;
      if (wc < 0 || wc > 1) {
        continue;
      }
      ys.push(wa * ay + wb * by + wc * cy);
      os.push(ix.owner[ti]);
    }
    // Topmost first, like `intersectObject` sorted by distance from above.
    const order = ys.map((_, j) => j).toSorted((p, q) => ys[q] - ys[p]);
    const take = Math.min(k, order.length);
    count[i] = take;
    for (let j = 0; j < take; j++) {
      hitY[i * k + j] = ys[order[j]];
      hitName[i * k + j] = os[order[j]];
    }
  }
  return { ground, hitY, hitName, count, k, names: ix.names };
};

// The six uniform slots the shader reads this frame. `slots[].push`/`.wash` are the effect; `tracks[].lag` is the gap between a body and its own wake. Null with ?sway=0.
(window as unknown as { __dbgSway: () => unknown }).__dbgSway = () => world.swayDebug?.() ?? null;

(
  window as unknown as {
    __dbgStructures: (x: number, z: number, r?: number) => unknown[];
  }
).__dbgStructures = (x, z, r = 30) => {
  const b: number[] = [];
  world.debugStructures(b);
  const out: Array<Record<string, number>> = [];
  // A COLUMN, NOT A DISC: with the island overhead its boxes fall inside whatever ground town it is above
  // — the Encampment came back with 73 against a budget of 64. A tower is 24 and the island cruises at 190.
  const CEILING = 60;
  const ground = world.getHeight(x, z);
  for (let i = 0; i < b.length; i += 6) {
    const d = Math.hypot(b[i] - x, b[i + 1] - z);
    if (d > r) {
      continue;
    }
    if (b[i + 5] > ground + CEILING) {
      continue;
    }
    out.push({
      x: +b[i].toFixed(2),
      z: +b[i + 1].toFixed(2),
      hx: +b[i + 2].toFixed(2),
      hz: +b[i + 3].toFixed(2),
      yaw: +b[i + 4].toFixed(3),
      top: +b[i + 5].toFixed(2),
      ground: +world.getHeight(b[i], b[i + 1]).toFixed(2),
      dist: +d.toFixed(2),
      area: +(4 * b[i + 2] * b[i + 3]).toFixed(2),
    });
  }
  out.sort((p, q) => q.area - p.area);
  return out;
};

// The overlay as numbers. `__dbgStructures` reads the collision data, this reads the PICTURE, and they
// can disagree: only a cage's top comes from the field and its base is inferred, which drew every
// collider on the flying settlement as a 200-unit shaft to the meadow (issue #112).
(
  window as unknown as {
    __dbgColliderView: (on?: boolean) => unknown;
  }
).__dbgColliderView = (on) => {
  if (on !== undefined) {
    colliderView.setVisible(on);
  }
  return {
    visible: colliderView.isVisible,
    count: colliderView.count,
    boxes: colliderView.boxCount,
    ridges: colliderView.ridgeCount,
    carried: colliderView.carriedCount,
    tallest: +colliderView.tallestCage.toFixed(2),
    tallestAt: (() => {
      const s = colliderView.tallestAt;
      return s === null
        ? null
        : {
            x: +s.x.toFixed(2),
            z: +s.z.toFixed(2),
            base: +s.base.toFixed(2),
            top: +s.top.toFixed(2),
            ground: +world.getHeight(s.x, s.z).toFixed(2),
          };
    })(),
  };
};

// `fit` is why this is not folded into `__dbgStructures`: how far the cylinder stands off the thatch at its worst point, which a box could never report.
(
  window as unknown as {
    __dbgRidges: (x: number, z: number, r?: number) => unknown[];
  }
).__dbgRidges = (x, z, r = 30) => {
  const b: number[] = [];
  world.debugRidges(b);
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < b.length; i += 8) {
    const d = Math.hypot(b[i] - x, b[i + 1] - z);
    if (d > r) {
      continue;
    }
    out.push({
      x: +b[i].toFixed(2),
      z: +b[i + 1].toFixed(2),
      yaw: +b[i + 2].toFixed(3),
      hl: +b[i + 3].toFixed(2),
      r: +b[i + 4].toFixed(2),
      y: +b[i + 5].toFixed(2),
      ry: +b[i + 6].toFixed(2),
      fit: +b[i + 7].toFixed(3),
      crest: +(b[i + 5] + b[i + 6]).toFixed(2),
      ground: +world.getHeight(b[i], b[i + 1]).toFixed(2),
      dist: +d.toFixed(2),
    });
  }
  out.sort((p, q) => q.hl * q.r - p.hl * p.r);
  return out;
};

// The two numbers issue #131 is about, off the streamed foliage's own VERTICES: how many stand inside a
// building, and how many right up against one. BOTH, because emptying a disc round every settlement
// satisfies the first and is explicitly not wanted — `hits` is the bug, `snug` is what the fix must not
// throw away, and 0 with 0 is a bald camp.
//
// VERTICES AND NOT PLACEMENTS: asking the placer whether it obeyed its own disc proves only that the
// arithmetic ran. THE SAME FIELD (`World.foliageSite`), because `debugStructures` merges in the people
// and whatever flies overhead — it reported a quarter of a million clips under the sky island. `verts`
// separates "nothing is clipping" from "nothing has streamed".
(
  window as unknown as {
    __dbgFoliageClip: (x: number, z: number, r?: number, gap?: number) => unknown;
  }
).__dbgFoliageClip = (x, z, r = 40, gap = 0.5) => {
  const site = world.foliageSite;
  let hits = 0;
  let snug = 0;
  let verts = 0;
  const at = { x: 0, y: 0, z: 0 };
  const r2 = r * r;
  engine.scene.traverse((o) => {
    if (o.name !== "chunk:props" && o.name !== "chunk:grass") {
      return;
    }
    const p = (o as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute;
    const a = p.array as ArrayLike<number>;
    for (let i = 0; i < a.length; i += 3) {
      const vx = a[i] + o.position.x;
      const vz = a[i + 2] + o.position.z;
      const dx = vx - x;
      const dz = vz - z;
      if (dx * dx + dz * dz > r2) {
        continue;
      }
      verts++;
      const vy = a[i + 1] + o.position.y;
      // `gap` first: it is the wider question, and a vertex it rejects cannot be inside anything either.
      if (!site.hits(vx, vz, gap, vy, vy)) {
        continue;
      }
      // A POINT — radius zero, no height band: this vertex exactly where it is drawn, which is a strictly harder
      // question than the one the placer answered about the whole prop.
      if (site.hits(vx, vz, 0, vy, vy)) {
        hits++;
        if (hits === 1) {
          at.x = vx;
          at.y = vy;
          at.z = vz;
        }
      } else {
        snug++;
      }
    }
  });
  return { x, z, radius: r, gap, verts, hits, snug, at: hits > 0 ? at : null };
};

// The price of settlement collision, measured: "do not linear-scan every collider, do not index sixty
// boxes either" is only answerable with a number. Call it inside the Encampment and out in open
// country; the two say whether the grid in world/structures.ts earns its fifteen lines.
(
  window as unknown as {
    __dbgBenchStructures: (x: number, z: number, n?: number) => unknown;
  }
).__dbgBenchStructures = (x, z, n = 200000) => {
  // Wander the sample point over a few units so the loop is not one perfectly predicted branch on a warm cache line.
  let sink = 0;
  const run = (): number => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const top = world.structureTopAt(x + (i % 97) * 0.05, z + (i % 89) * 0.05);
      if (top > sink) {
        sink = top;
      }
    }
    return ((performance.now() - t0) * 1e6) / n;
  };
  run(); // warm
  const ns = Math.min(run(), run(), run());
  return { x, z, calls: n, nsPerCall: +ns.toFixed(1), sink };
};

// Every program three holds, as `type|cacheKey` — the instrument the zone warm-up was built with.
// `perf.count('programs')` says one was linked, this says WHICH: diffing either side of an event showed
// the dungeon linking 25 at light counts 0 and 1, because four den lamps had floored every count at 4.
(window as unknown as { __dbgProgKeys: () => string[] }).__dbgProgKeys = () =>
  (engine.renderer.info.programs ?? []).map(
    (p) =>
      `${(p as unknown as { type: string }).type}|${(p as unknown as { cacheKey: string }).cacheKey}`,
  );

(
  window as unknown as {
    __dbgTime: (value?: number | null | "clear" | "dawn" | "noon" | "dusk" | "midnight") => unknown;
  }
).__dbgTime = (value) => {
  if (value !== undefined) {
    const named = { clear: null, dawn: 0.25, noon: 0.5, dusk: 0.75, midnight: 0 } as const;
    const phase = typeof value === "string" ? named[value] : value;
    dayNight.setDebugOverride(phase);
    perfPanel.refresh();
  }
  const lighting: Record<string, number> = {};
  const seen = new Set<THREE.Material>();
  engine.scene.traverse((object) => {
    const point = object as THREE.PointLight;
    const lightRole = point.userData.bsNightRole as string | undefined;
    if (point.isPointLight && lightRole) {
      lighting[lightRole] = (lighting[lightRole] ?? 0) + point.intensity;
    }
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (seen.has(material)) {
        continue;
      }
      seen.add(material);
      const role = material.userData.bsNightRole as string | undefined;
      if (role && material instanceof THREE.MeshStandardMaterial) {
        const debugIntensity = material.userData.bsDebugIntensity;
        lighting[role] =
          typeof debugIntensity === "number" ? debugIntensity : material.emissiveIntensity;
      }
    }
  });
  return {
    phase: dayNight.phase,
    source: dayNight.source,
    quest: dayNight.quest,
    debugOverride: dayNight.debugOverride,
    daylight: dayNight.daylight,
    night: dayNight.night,
    stars: dayNight.stars,
    moon: dayNight.moon,
    exposure: engine.renderer.toneMappingExposure,
    sunDirection: dayNight.sunDirection.toArray(),
    moonDirection: dayNight.moonDirection.toArray(),
    keyDirection: dayNight.keyDirection.toArray(),
    lighting,
    shadow: engine.shadowDebug(),
  };
};

(
  window as unknown as {
    __dbgGfx: (id?: string, value?: unknown) => unknown;
  }
).__dbgGfx = (id, value) => {
  if (id === undefined) {
    // COUNTED OFF THE SCENE, not off the setting: grass switched off came back in patches while walking,
    // because chunks built through the immediate path never heard about it, and a draw-call delta could not
    // see that. TERRAIN is in here and is not a layer, deliberately — the first version left unrecognised
    // layers at whatever the last setVisible(false) did, so a player near a gateway had no ground.
    const layers: Record<string, { shown: number; hidden: number }> = {
      terrain: { shown: 0, hidden: 0 },
      grass: { shown: 0, hidden: 0 },
      props: { shown: 0, hidden: 0 },
      water: { shown: 0, hidden: 0 },
    };
    engine.scene.traverse((o) => {
      const key = o.name.startsWith("chunk:") ? o.name.slice(6) : null;
      if (key && layers[key]) {
        layers[key][o.visible ? "shown" : "hidden"]++;
      }
    });
    return { open: perfPanel.isOpen, values: gfx.snapshot(), layers };
  }
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  if (!opt) {
    return null;
  }
  if (value !== undefined) {
    gfx.set(opt.id, opt.choices ? Number(value) : Boolean(value));
    perfPanel.refresh();
  }
  return gfx.get(opt.id);
};

// The hero's hair: read it, or change it. The VERTEX COUNT is what a probe asserts a style swap on —
// two meshes with the same geometry are the same head. A DRIVER with arguments, through the same
// `appearance` control the panel uses, so a probe cannot pass a test a click would fail; `null` colour
// clears the pick.
(
  window as unknown as {
    __dbgHair: (style?: string, colour?: string | number | null) => unknown;
  }
).__dbgHair = (style, colour) => {
  if (style !== undefined) {
    appearance.setStyle(style);
    if (colour !== undefined) {
      if (colour === null) {
        appearance.reset();
      } else {
        appearance.setColour(
          typeof colour === "string" ? parseInt(colour.replace("#", ""), 16) : colour,
        );
      }
    }
    perfPanel.refresh();
  }
  const mesh = player.rigHairMesh;
  const colours = mesh?.geometry.getAttribute("color");
  // The MEAN VERTEX COLOUR of the hair, which is where a hair colour actually lives: `VoxelModel` bakes it into the attribute and there is no material to read it off.
  const tint = [0, 0, 0];
  if (colours) {
    for (let i = 0; i < colours.count; i++) {
      tint[0] += colours.getX(i);
      tint[1] += colours.getY(i);
      tint[2] += colours.getZ(i);
    }
    for (let c = 0; c < 3; c++) {
      tint[c] = +(tint[c] / colours.count).toFixed(4);
    }
  }
  return {
    style: player.hairStyle,
    colour: player.hairColour.toString(16).padStart(6, "0"),
    styles: HAIR_STYLES.map((s) => s.id),
    swatches: HAIR_SWATCHES.length,
    vertices: mesh ? mesh.geometry.getAttribute("position").count : 0,
    tint,
  };
};

// A READER with no arguments and a DRIVER with two, through the same `spawnCatalogue.spawn` a click uses, so a probe cannot pass a test the panel would fail.
(
  window as unknown as {
    __dbgSpawn: (branch?: string, row?: string) => unknown;
  }
).__dbgSpawn = (branch, row) => {
  if (branch === undefined || row === undefined) {
    return {
      open: perfPanel.isOpen,
      typing: perfPanel.isTyping,
      structures: world.debugSpawn?.count ?? null,
      // The wild population, so the enemy branch can be asserted on a COUNT rather than on the sentence the panel printed.
      enemies: combat.enemies.length,
      // WHERE A SPAWN WOULD LAND RIGHT NOW, beside where the old blind offset would have put it: that
      // difference IS the feature, and the two points coincide only with a level camera pointed his way.
      spot: (() => {
        const s = spawnSpot();
        return {
          x: +s.x.toFixed(2),
          z: +s.z.toFixed(2),
          yaw: +s.yaw.toFixed(3),
          ground: +world.getHeight(s.x, s.z).toFixed(2),
        };
      })(),
      ahead: {
        x: +(player.position.x + Math.sin(player.facing) * SPAWN_AHEAD).toFixed(2),
        z: +(player.position.z + Math.cos(player.facing) * SPAWN_AHEAD).toFixed(2),
      },
      branches: spawnCatalogue.branches().map((b) => ({ id: b.id, rows: b.rows.length })),
    };
  }
  return spawnCatalogue.spawn(branch, row);
};

// The cursor: what is showing, whether the sheet decoded, and — as a TEST HOOK — a way to ask what a
// screen point would resolve to without moving a real mouse. `states` proves all sixteen tiles were cut.
(
  window as unknown as {
    __dbgCursor: (x?: number, y?: number) => unknown;
  }
).__dbgCursor = (x, y) => {
  if (x !== undefined && y !== undefined) {
    // Drive the real listener rather than a copy, so this reports what a player's mouse would get.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
  }
  return { ...cursors.debug(), free: cursorFree, known: CURSOR_STATES.length };
};

// WHAT LIVES WHERE (issue #204): each biome's resolved table as percentages, plus what the population
// standing in the world right now actually is — the pair, because a table nothing rolls from and a
// population that ignores its table are different bugs.
(window as unknown as { __dbgSpawnTables: () => unknown }).__dbgSpawnTables = () => ({
  zone: zones.id,
  biome: world.biomeAt(player.position.x, player.position.z),
  tables: spawnTableReport(),
  // Which species CAN fly, so a probe can say "no flyer is in an Act 1 table" against the roster
  // rather than against four ids written into the test.
  flying: enemySpecies()
    .filter((e) => e.flying)
    .map((e) => e.id),
  live: combat.enemies.map((e) => ({
    species: e.species,
    biome: world.biomeAt(e.position.x, e.position.z),
  })),
});

// WHERE THE STORY DRESSES A SCENE. Both are DERIVED — the Hold's floor from its seed, the drove ground
// from Stonewatch's own gate — so a probe walks to whatever the game chose instead of keeping a second
// copy of the arithmetic that put it there.
(window as unknown as { __dbgQuestSites: () => unknown }).__dbgQuestSites = () => ({
  holdFloor: holdFloorSpot(),
  droveGround: droveGround(),
  drownedMarket: drownedMarket(),
  vaneWreck: vaneWreck(),
  mawsRest: mawsRest(),
  // The Encampment's taming pen — the camp layout's own answer (issue #178).
  pen: world.tamingPen,
});

// THE STANDING STONES: where they are, which are lit, and which one a faint would use from here — the
// three readings a probe needs, and the third is the POLICY rather than a copy of it.
(window as unknown as { __dbgWaypoints: () => unknown }).__dbgWaypoints = () => {
  const field = world.waypoints;
  return {
    zone: zones.id,
    all: (field?.all ?? []).map((w) => ({
      id: w.id,
      x: +w.x.toFixed(2),
      y: +w.y.toFixed(2),
      z: +w.z.toFixed(2),
      lit: waypointLit(w.id),
      // Where its trail leaves the road, so a probe can walk the line the game
      // cut rather than a line of its own.
      from: w.from,
    })),
    touching: field?.touching(player.position.x, player.position.z)?.id ?? null,
    // The wider band that actually LIGHTS one (issue #250).
    sensing: field?.sensing(player.position.x, player.position.y, player.position.z)?.id ?? null,
    respawnAt: player.respawnAt?.(player.position.x, player.position.z) ?? null,
  };
};

(window as unknown as { __dbgDraws: () => number }).__dbgDraws = () =>
  engine.renderer.info.render.calls;

// THE FERRY, for tools/test-brine.mjs: where the piers are, whether the boats are
// moored, and whether a sail is in flight. `sailing` is the phase, null at rest.
(window as unknown as { __dbgFerry: () => unknown }).__dbgFerry = () => ({
  present: ferry !== null,
  sailing: sail?.phase ?? null,
  ...(ferry ? (ferry.debug() as object) : {}),
});

(window as unknown as { __dbgZone: () => unknown }).__dbgZone = () => ({
  ...(zones.debug() as Record<string, unknown>),
  // Live GPU-side totals, which is how "the overworld really did unload" is shown rather than asserted:
  // `geometries` is three's own count of live buffer geometries and drops by the whole chunk set.
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
    id: p.id,
    species: p.species.id,
    owned: isOwned(p),
    level: p.level,
    xp: p.xp,
    hp: +p.hp.toFixed(2),
    maxHp: p.maxHp,
    skills: p.knownSkillIds.slice(),
  })),
});

// Every body that steers itself, and WHAT IT IS STANDING IN. "A beast walks through the hut its owner
// leans on" is the one way settlement collision looks worse than none, and `structureTop` above a body's
// feet means it is inside a wall. Fliers carry their locomotion: they are SUPPOSED to be over the roof.
(window as unknown as { __dbgBodies: () => unknown }).__dbgBodies = () => {
  const at = (p: THREE.Vector3, feet: number): number | null => {
    const top = world.structureTopAt(p.x, p.z);
    return top === -Infinity ? null : +(top - feet).toFixed(2);
  };
  return {
    player: {
      x: +player.position.x.toFixed(2),
      y: +player.position.y.toFixed(2),
      z: +player.position.z.toFixed(2),
      overFeet: at(player.position, player.position.y),
    },
    // The two ACTIVE followers only: the rest of the roster is benched at the origin, where "is it inside
    // a wall" means nothing. An empty list is an empty party, which is what a new game is.
    beasts: [primary(), support()]
      .filter((p): p is BeastActor => p !== null)
      .map((p) => ({
        id: p.species.id,
        locomotion: p.species.locomotion,
        x: +p.position.x.toFixed(2),
        y: +p.position.y.toFixed(2),
        z: +p.position.z.toFixed(2),
        /** Structure top MINUS the body's feet. Above ~0.5 it is in a wall. */
        overFeet: at(p.position, p.position.y),
      })),
    enemies: combat.enemies.map((e) => ({
      // Stable for this actor's lifetime: a movement probe must keep measuring the same enemy.
      id: e.root.id,
      species: e.species,
      x: +e.position.x.toFixed(2),
      y: +e.position.y.toFixed(2),
      z: +e.position.z.toFixed(2),
      // ADDITIVE. Health is here so a tool can assert a swing LANDED without a second probe — tools/test-aim-assist.mjs reads it either side of an attack.
      hp: +e.hp.toFixed(2),
      maxHp: e.maxHp,
      isDead: e.isDead,
      // What every combat scan filters on (`!isDead && !held`) — a staging probe
      // must count what a player could actually engage (tools/test-rookery.mjs).
      targetable: e.targetable,
      overFeet: at(e.position, e.position.y),
      // The AUTHORED footprint and, for a wild beast, the one its rig measured. They drift silently: the hp bar floats and the thing is reached from the wrong distance.
      radius: +e.radius.toFixed(2),
      height: +e.height.toFixed(2),
      rigRadius: e.rigRadius === null ? null : +e.rigRadius.toFixed(2),
      rigHeight: e.rigHeight === null ? null : +e.rigHeight.toFixed(2),
      /** Inside a taming orb right now. See `Enemy.setHeld`. */
      held: e.held,
    })),
  };
};
