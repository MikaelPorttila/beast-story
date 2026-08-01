import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Input } from './core/input';
import { TouchControls, isTouchPrimary } from './core/touch';
import { GamepadControls } from './core/gamepad';
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
import { CombatSystem } from './combat/index';
import { HUD, kbd, type BeastHudInfo, type ShopOffer, type SkillSlot } from './ui/index';
import { StartMenu } from './ui/menu';
import { ALL_SPECIES, SKILLS, getSkill } from './beasts/registry';

const app = document.getElementById('app')!;
const engine = new Engine(app);
const input = new Input(engine.renderer.domElement);
const bus = new EventBus();

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
 * The interact prompt, composed once at load and again on a language change.
 *
 * The hint pill is HTML and the key cap arrives inside the `{key}` placeholder
 * (see HUD.showHint and `kbd`), so this is a `t(key, vars)` call — which
 * allocates. It is hoisted out of the frame loop for exactly that reason: the
 * loop below runs it every frame the hero is stood near a den. Same argument as
 * SHOP_FOOT_HINTS in src/ui/index.ts.
 *
 * A `let` rather than a `const` only because the start menu can now change the
 * language under it — see `onLanguageChange` below, which is the ONE place that
 * writes it. It is still composed a handful of times per session, never per
 * frame.
 */
let skillDenHint = t('hint.skillDen', { key: kbd('E') });

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
  },
  onHint: (t) => { portalHint = t; },
});

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
  skillDenHint = t('hint.skillDen', { key: kbd('E') });
  dialogueFoot = t('npc.dialogue.close', { key: kbd('E') });
  npcHints.clear();
  hud.relabel();
  touch?.relabel();
});

// Gamepad: non-null wherever the API exists, whether or not anything is plugged
// in yet — a pad can arrive mid-session and the connect listener has to be live
// to catch it. It stays free until one does; see core/gamepad.ts.
// Stored player choices, read once. URL beats preference and never writes back
// — see core/flags.ts.
const prefs = loadPrefs();
const pad = photoMode ? null : GamepadControls.attach(input, {
  look: {
    invertX: flags.invertLookX ?? prefs.invertLookX,
    invertY: flags.invertLookY ?? prefs.invertLookY,
  },
});

// Rumble and camera shake, driven off the bus. Null in photo mode for the same
// reason the touch overlay is: a staged capture must not have the camera kicked
// out from under it by whatever happened to be hitting the hero.
//
const feedback = photoMode ? null : new FeedbackSystem({
  bus,
  camera: player.cam,
  pad: () => pad?.current ?? null,
  hapticIntensity: flags.haptics ?? prefs.hapticIntensity,
  shakeIntensity: flags.shake ?? prefs.shakeIntensity,
});

// ---------------------------------------------------------------------------
// The title screen.
//
// It is the FIRST thing on screen and the game does not begin until it says so:
// `menuOpen()` below stands the hero down every slice while it is up. The world
// keeps streaming behind it, which is the entire reason it is a gate rather
// than a separate page — by the time New Game is pressed the chunks around
// spawn are built, so the poster fades onto a world that is already there
// instead of onto a hitch.
//
// The "play fullscreen?" pill USED to be raised here, on the game's first
// frame, next to the welcome toast. The menu owns it now, as its own step
// straight after "Press start..." (ui/menu.ts), which is both a better moment
// to ask and the reason the pill stopped remembering an answer — see the header
// of ui/fullscreen.ts.
//
// Null in photo mode, and null under `menu=0`, which is what every probe in
// tools/ passes: a title screen in front of the hero would make each of them
// measure the menu instead of the thing they exist to measure.
// ---------------------------------------------------------------------------
const startMenu = StartMenu.offer({
  // The poster has begun dissolving, so the world behind it is being looked at
  // again: back to whatever frame rate this load actually asked for. See
  // MENU_FPS below for what was standing it down and why.
  onLeave: () => engine.setFpsCap(fpsCap),
  onStart: () => {
    // Deferred to here rather than emitted at load: a toast lives about four
    // seconds, and raised behind the poster it would have expired before the
    // player ever saw the game.
    bus.emit({
      type: 'toast',
      // A touchscreen laptop driven by mouse gets the desktop hint: `touch` is
      // non-null there (it ticks the camera stick) but stays hidden until a touch.
      text: t(isTouchPrimary() ? 'toast.welcome.touch' : 'toast.welcome.desktop'),
    });
  },
  // Straight through to the pad, which takes a change at any time by design —
  // see GamepadControls.setLookAxes. The preference itself is saved by the menu.
  onLookAxes: (a) => pad?.setLookAxes(a),
});

/** True while the title screen is up and the hero must not move. */
const menuOpen = (): boolean => startMenu?.isOpen ?? false;

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
// The welcome toast moved into the title screen's `onStart` above — it is the
// first thing the player is told, and it has to be said when they are looking
// at the game rather than at a poster. Photo mode and `menu=0` have no menu to
// fire it, and neither wants a toast in shot.

// ?fps=<n> caps the frame rate (0 or absent = uncapped). F2 shows measured FPS.
const fpsCap = Number(params.get('fps') ?? 0);
engine.setFpsCap(fpsCap);
const debug = new DebugOverlay(engine.renderer, fpsCap);
if (params.get('debug') === '1') debug.toggle();

/**
 * Frame cap while the title screen COVERS the game, and the reason it exists.
 *
 * Uncapped, the renderer draws as fast as the display asks — 165 frames a
 * second on the machine this was measured on — and while the poster is up every
 * one of those frames is a full pass of the world plus GTAO, bloom and SMAA
 * behind an opaque picture. Measured over a 6 s window at 1920x1080: 96.9% of
 * the main thread with the menu up, of which 93.4% was the game and about 3.5
 * the poster itself. Capped to 20 it is 27%. The fans spinning up on what looks
 * like a still image is the whole complaint, and this is the whole fix — the
 * menu's own lantern pulse and fairies are CSS animations on the compositor and
 * do not care what the game's loop is doing.
 *
 * 20 rather than 10 (19.7%, so barely cheaper) because the world is still
 * STREAMING behind the poster at one or two chunks a frame, and that is the
 * point of rendering at all rather than stopping dead: 20 fps fills the ring
 * around spawn in a few seconds, which is faster than anyone reads a title
 * screen. It is restored on `onLeave` — the start of the exit fade, half a
 * second before the game is handed over — so the dissolve itself runs at full
 * rate and the world gets that half second uncapped to finish anything left.
 */
const MENU_FPS = 20;
if (startMenu?.isOpen) engine.setFpsCap(MENU_FPS);

perf.enabled = params.get('perf') === '1';
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
      ? `colliders ON — ${colliderView.count} drawn, ${colliderView.boxCount} of them `
        + 'settlement boxes (green solid, blue climb)'
      : 'colliders OFF';
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

// Feedback tuning, which is the whole settings surface for now — there is no
// options panel, and one would be its own problem (pause semantics, pad focus
// navigation, a string key per label). These two plus `?haptics=` / `?shake=`
// cover both tuning and a bug report; a real panel lands when there is a second
// reason for one.
devConsole?.register({
  name: 'haptics',
  args: '[<0..1>]',
  help: 'Show or set controller rumble strength. Persists.',
  run: (args) => setFeedbackPref('hapticIntensity', args[0], flags.haptics),
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

function warmUpShaders(): void {
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

  // Then one light at a time, one render each, to the pool's cap. EXACTLY one:
  // adding two per pass leaves every odd count uncompiled, which is a real bug
  // this code already had — three projectiles in flight at once then hit an
  // unseen count mid-fight and recompiled twelve materials in one frame.
  const POOL = 10; // VFX light pool cap
  for (let i = 1; i < POOL; i++) warmUpFrame(_warmStage, 1);

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
  }
  for (const r of world.towns.roads) {
    const m = Math.floor(r.path.length / 6) * 3;
    _warmStage.set(r.path[m], r.path[m + 1] + 1, r.path[m + 2]);
    warmUpFrame(_warmStage, 0);
  }
  _warmStage.copy(world.spawnPoint);
  _warmStage.y += 1;

  // The two underwater programs (screen tint, bubbles). They are drawn by
  // nothing above — the camera is in the air at boot, so the sweep never touches
  // them — and the frame they would otherwise link on is the frame the hero's
  // head goes under, which is a stall in the middle of a swim.
  underwater.warmUp(() => engine.render());

  // NOT renderer.compile(scene, camera). It was tried and measured: it linked
  // 117 programs in one go and made boot dramatically WORSE (593 ms, 429 ms and
  // 287 ms stalls in the first 1.5 s, against ~110 ms without it), because it
  // links every permutation in the graph whether or not it will ever be drawn,
  // and the driver then compiles the lot. Drawing one of each thing, as above,
  // is both cheaper and closer to what the GPU actually needs.

  // Expire everything the warm-up spawned: every effect above was given a life
  // measured in hundredths of a second, so one long update clears the lot.
  combat.update(5, player as unknown as Damageable, []);
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
    html = t('hint.npcTalk', { key: kbd('E'), name: t(npc.nameKey) });
    npcHints.set(npc.id, html);
  }
  return html;
}
/** The dialogue panel's footer. Composed once, like the hints above. */
let dialogueFoot = t('npc.dialogue.close', { key: kbd('E') });

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
  // act on it. Same treatment the shop already gets.
  const shopOpen = hud.isShopOpen() || !!devConsole?.isOpen;
  nearShop = false;
  nearNpc = null;
  // Whose contact the particle system tests this slice, or null. It integrates
  // on EVERY slice either way — a modal overlay freezes the hero, not the leaves
  // already falling behind it — so only the contact test needs someone to test.
  let toucher: Player | null = null;

  // The camera stick is a rate control, so it must inject its look delta BEFORE
  // the player/camera update consumes mouseDX this frame — ticking it later in
  // the frame meant endFrame() wiped the delta before the camera ever saw it.
  if (interactive && !shopOpen) touch?.update(dt);

  // Photo mode drives the camera and the subject itself and must not have the
  // player controller or the HUD fighting it, but it DOES need the world to
  // stream and the beasts to animate — everything below the branch.
  if (!interactive) {
    // fall through to the world update
  } else if (!shopOpen) {
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
      ? npcField.nearest(player.position.x, player.position.z, NPC_TALK_RANGE)
      : null;
    if (first && input.pressed('KeyE')) {
      if (npcField?.talking) npcField.endTalk();
      else if (nearNpc) npcField?.talk(nearNpc.id);
      else if (nearShop) tryOpenShop();
    }
    if (first && npcField?.talking && input.pressed('Escape')) npcField.endTalk();
  } else if (first && (input.pressed('Escape') || input.pressed('KeyE'))) {
    hud.closeShop();
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
  requestAnimationFrame(frame);
  if (!engine.beginFrame()) return;
  perf.begin();
  const dt = engine.tick();
  const shopOpen = hud.isShopOpen();

  // Poll the pad ONCE PER RENDERED FRAME, and before the slices below.
  //
  // Both halves matter. Look delta accumulated here behaves exactly like mouse
  // movement — integrated over wall-clock, consumed by whichever slice runs —
  // whereas polling per slice would multiply the turn rate by the slice count.
  // And the edges land before slice 0, the one `first` is true for, which is
  // what the hotbar, Tab, the beast cycles and the shop key are all gated on.
  pad?.setModal(shopOpen || !!devConsole?.isOpen);
  pad?.poll(dt);

  // Drain the accumulator in fixed slices; carry the remainder to next frame.
  simAccumulator += dt;
  let steps = 0;
  while (simAccumulator >= SIM_DT && steps < MAX_STEPS) {
    // `interactive` is what decides whether the hero reads the input device this
    // slice. The title screen turns it off for the same reason photo mode does:
    // the world must go on streaming and rendering behind the poster, but a key
    // press belongs to the menu and must not also walk the hero into a tree
    // before the player has pressed New Game.
    simulate(SIM_DT, steps === 0, !photoMode && !menuOpen());
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
  // Key caps or controller faces. Cheap: returns on the first line unless the
  // device actually changed, which happens at most once or twice a session.
  hud.setPadPrompts(input.padActive && pad ? pad.glyphs : null);
  hud.setMountHold(mount.progress);
  hud.setMounted(
    mount.beast ? t(mount.beast.species.nameKey) : null,
    mount.beast ? mount.beast.species.locomotion === 'flying' : false,
  );
  hud.update(dt);

  // Hide the touch overlay while a modal shop is open so it can't be tapped
  // through, and release any held virtual buttons.
  touch?.setVisible(!shopOpen);

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

  if (input.pressed('F2')) debug.toggle();
  colliderView.update(dt);
  perf.section('hud');

  // AFTER every camera decision this frame (the player controller's, or photo
  // mode's above) and before the render: the effect keys off where the lens
  // actually ends up, and a frame late is a frame of clear water at the surface.
  underwater.update(dt, world.isWater(engine.camera.position.x, engine.camera.position.z));

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
// Pay for every shader before the first gameplay frame. `warmup=0` skips it,
// which is how the freeze it prevents can be reproduced on demand.
//
// One simulation slice runs FIRST so there is something to warm: it primes the
// enemy population and teleports the beasts to the player, both of which are
// still at the origin (and so out of frame, and so uncompiled) before it.
if (params.get('warmup') !== '0') {
  simulate(SIM_DT, true, !photoMode);
  warmUpShaders();
}
frame();

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
    fromPlayer: +Math.hypot(n.x - player.position.x, n.z - player.position.z).toFixed(2),
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
      overFeet: at(e.position, e.position.y),
    })),
  };
};
