import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Input } from './core/input';
import { TouchControls, isTouchPrimary } from './core/touch';
import {
  EventBus,
  type CrownContact, type SkillDef, type Damageable, type World, type WorldBound,
} from './core/types';
import { Inventory, itemDef } from './core/items';
import { perf } from './core/profiler';
import { flags } from './core/flags';
import { DevConsole } from './ui/console';
import { ColliderView } from './core/collider-view';
import { createWorld, type LandmarkProbe } from './world/index';
import { createDungeon } from './world/dungeon';
import { ZoneManager, type ZoneDef } from './world/zones';
import { Underwater } from './world/underwater';
import { TouchParticles } from './world/touch-particles';
import { Player } from './player/index';
import { MountController } from './player/mount';
import { PalActor, registerSkillDefs } from './pals/framework';
import { CombatSystem } from './combat/index';
import { HUD, type PalHudInfo, type ShopOffer, type SkillSlot } from './ui/index';
import { ALL_SPECIES, SKILLS, getSkill } from './pals/registry';

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

const OVERWORLD: ZoneDef = {
  id: 'overworld',
  name: 'Embervale',
  create: (scene) => createWorld(scene, 1337, (probe) => {
    gateSite = findGateSpot(probe);
    return [gateSite];
  }),
  gate: () => ({ to: 'hold', x: gateSite!.x, z: gateSite!.z, hex: 0x8be3ff }),
};

const HOLD: ZoneDef = {
  id: 'hold',
  name: 'The Sunken Hold',
  create: (scene) => createDungeon(scene, 0x5ea1ed),
  // The way out stands on the way in: you arrive on the return gateway, which
  // is exactly why it starts disarmed (see EXIT_R in world/zones.ts).
  gate: (w) => ({ to: 'overworld', x: w.spawnPoint.x, z: w.spawnPoint.z, hex: 0xffc46b }),
};

/** Everything that captured a World at construction; rebound on every switch. */
const bound: WorldBound[] = [];
/** Set by the zone manager each slice; consumed by the HUD hint below. */
let portalHint: string | null = null;

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
    // The pals need no placement: their follow update teleports any pal whose
    // owner is further than TELEPORT_DIST away, and a zone is by construction
    // further than that, so they poof in beside him on the next slice using the
    // new world's ground height.
    bus.emit({ type: 'toast', text: `Entered ${def.name}` });
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

// Hold F to ride your pal. The controller owns the hold timer, the refusal
// rules and a mounted pal's locomotion; which pal is offered (the primary, see
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
// Pal roster: all 10 species instantiated; two active at a time.
// ---------------------------------------------------------------------------
registerSkillDefs(SKILLS.values());
const roster: PalActor[] = ALL_SPECIES.map(
  (sp) => new PalActor(sp, engine.scene, world, bus),
);
// The rebind list. Order does not matter — every setWorld is independent — but
// the roster is the reason the list exists at all: a pal's level, xp and known
// skills are the save game, and rebuilding one to change zones would delete it.
bound.push(player, mount, combat, touchFx, ...roster);
let primaryIdx = 0; // Emberfox
let supportIdx = 6; // Galebird
const cooldowns = new Map<string, number>();

function primary(): PalActor { return roster[primaryIdx]; }
function support(): PalActor { return roster[supportIdx]; }

// `pals=0` hides the party and skips its per-frame update, so a measurement run
// can price what the two active pals cost to animate and draw. It does NOT skip
// building the rigs — the roster is still constructed, because half of main.ts
// reads primary()/support() and a null roster would need guards everywhere for
// the sake of a diagnostic. Rig construction is a boot cost; read it off the
// boot phase of a profile instead. See core/flags.ts.
function refreshVisibility(): void {
  roster.forEach((p, i) => p.setVisible(flags.pals && (i === primaryIdx || i === supportIdx)));
}
refreshVisibility();

function cyclePal(which: 'primary' | 'support', dirn: 1 | -1): void {
  const n = roster.length;
  if (which === 'primary') {
    do { primaryIdx = (primaryIdx + dirn + n) % n; } while (primaryIdx === supportIdx);
  } else {
    do { supportIdx = (supportIdx + dirn + n) % n; } while (supportIdx === primaryIdx);
  }
  refreshVisibility();
  bus.emit({ type: 'toast', text: `${primary().species.name} leads · ${support().species.name} supports` });
}

// ---------------------------------------------------------------------------
// Shards (pickups tracked by combat; purchases tracked here)
// ---------------------------------------------------------------------------
let pickupTotal = 50;
let spent = 0;
const shards = () => pickupTotal - spent;

// The bag holds STACKABLES only — shards stay the running total above. Combat
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
      if (e.byPal) {
        // The fetcher is whichever pal is carrying right now — normally the
        // support pal, but a Tab swap mid-errand must not misattribute it.
        const fetcher = roster.find((p) => p.isCarrying) ?? support();
        bus.emit({ type: 'toast', text: `${fetcher.species.name} fetched ${def.name} (${n})` });
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
// Fetch errands (support-pal AI, so it lives here)
// ---------------------------------------------------------------------------
// The rule, in one predicate:
//   currency   — always worth a trip. Money is money.
//   stackable  — only if the player ALREADY holds at least one. The pal tops up
//                stacks you have chosen to carry and leaves everything else on
//                the ground, so a fetcher never fills your bag with things you
//                have never picked up yourself. Walking over an item is how you
//                opt in to it, and from then on the pal collects that kind.
// It is the SUPPORT pal that runs these: the primary stays at the player's
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

function castFromPal(pal: PalActor, skill: SkillDef): void {
  const cd = cooldowns.get(skill.id) ?? 0;
  if (cd > 0) return;

  // Riding it changes where its skills go: from the saddle you are the one
  // aiming, so the crosshair wins outright and the auto-target is not even
  // consulted. Nothing else about the cast changes — the pal still plays the
  // cast animation and the shot still leaves from its muzzle.
  const aimed = mount.isMounted && pal === mount.pal;
  let target: Damageable | null = null;
  if (aimed) {
    engine.camera.getWorldDirection(_aim);
    // Face the mount along the shot so the muzzle offset in beginCast points
    // the right way; the vertical component stays on the projectile only.
    if (Math.abs(_aim.x) + Math.abs(_aim.z) > 1e-4) {
      pal.forward.set(_aim.x, 0, _aim.z).normalize();
    }
    // A LITTLE homing from the saddle: the shot leaves down the crosshair and
    // then leans toward whatever the crosshair was actually on. The target is
    // picked from the aim CONE, never "nearest enemy" — an enemy off to the
    // side is not what you pointed at, and curving onto it would be the autoaim
    // this deliberately is not.
    target = enemyInAim(pal.position, _aim, Math.max(skill.range, 12));
  } else {
    target = combat.findNearestEnemy(pal.position, Math.max(skill.range, 12));
    if (target) {
      pal.forward.copy(target.position).sub(pal.position).setY(0).normalize();
    }
  }

  const { origin, direction } = pal.beginCast(skill);
  const dir = aimed
    ? _aim
    : target
      ? new THREE.Vector3().copy(target.position).sub(origin).normalize()
      : direction;
  combat.cast({
    skill,
    caster: pal as unknown as Damageable & { forward: THREE.Vector3 },
    origin,
    direction: dir,
    target,
    // Aimed shots steer at a fraction of full lock-on, so the crosshair stays
    // the thing that decides where a shot goes and the assist only closes the
    // last little error. Full strength would quietly undo the aim you took.
    homingScale: aimed ? MOUNTED_HOMING : 1,
    attackStat: pal.stats.attack,
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
  for (const pal of [primary(), support()]) {
    for (const id of pal.species.skills) {
      const def = getSkill(id);
      if (!def || def.storePrice === undefined) continue;
      offers.push({
        skill: def,
        price: def.storePrice,
        owned: pal.knownSkillIds.includes(id),
        palName: pal.species.name,
        affordable: shards() >= def.storePrice,
      });
    }
  }
  return offers;
}

function tryOpenShop(): void {
  if (hud.isShopOpen()) return;
  document.exitPointerLock();
  hud.openShop('Skill Den', buildOffers(), (i) => {
    const offer = buildOffers()[i];
    if (!offer || offer.owned || !offer.affordable) return;
    spent += offer.price;
    const pal = [primary(), support()].find((p) => p.species.name === offer.palName);
    pal?.learnSkill(offer.skill.id);
    hud.setShards(shards());
    bus.emit({ type: 'toast', text: `${offer.palName} learned ${offer.skill.name}!` });
    hud.openShop('Skill Den', buildOffers(), () => {}, () => hud.closeShop());
  }, () => hud.closeShop());
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const palHud = (p: PalActor): PalHudInfo => ({
  name: p.species.name,
  element: p.species.element,
  level: p.level,
  xp: p.xp,
  xpToNext: p.xpToNext,
  hp: p.hp,
  maxHp: p.maxHp,
});

// ---------------------------------------------------------------------------
// Photo mode (for the visual critic pipeline):
//   ?photo=1&cam=x,y,z&look=x,y,z&pal=<speciesId>&anim=<action>
// cam/look are offsets relative to the spawn point.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const photoMode = params.get('photo') === '1';
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
  const palId = params.get('pal');
  if (palId || params.get('poff')) {
    // Portraits happen on open, FLAT ground so the camera never ends up buried
    // in a hillside. Each species starts from its own bearing on a ring (so ten
    // portraits aren't ten copies of the same postcard) then walks outward
    // until it finds a level, dry patch.
    const idx = Math.max(0, roster.findIndex((p) => p.species.id === palId));
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
  if (palId) {
    const idx = roster.findIndex((p) => p.species.id === palId);
    if (idx >= 0) primaryIdx = idx;
    // Staged portraits show ONE subject: hide the hero and every other pal so
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
(window as unknown as DebugProbes).__dbgCamYaw = () => Math.atan2(
  engine.camera.position.x - player.position.x,
  engine.camera.position.z - player.position.z,
);
(window as unknown as { __dbgInput: () => unknown }).__dbgInput = () => ({
  axisFwd: input.axisFwd,
  axisSide: input.axisSide,
  lookActive: input.lookActive,
  touchActive: input.touchActive,
  touchOverlay: !!document.querySelector('.cp-touch'),
  vel: { x: +player.velocity.x.toFixed(2), y: +player.velocity.y.toFixed(2), z: +player.velocity.z.toFixed(2) },
  onGround: player.onGround,
  isClimbing: player.isClimbing,
  attacking: player.isAttacking,
  isSwimming: player.isSwimming,
  isMounted: player.isMounted,
  isDead: player.isDead,
});

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
// fill, which pal is under you and what it is, the rider's height and speed,
// and the direction the last cast actually left in — `aimed` says whether that
// direction came from the crosshair or from the auto-target.
(window as unknown as { __dbgMount: () => unknown }).__dbgMount = () => ({
  mounted: mount.isMounted,
  pal: mount.pal?.species.id ?? null,
  locomotion: mount.pal?.species.locomotion ?? null,
  palSpeed: mount.pal ? +mount.pal.stats.speed.toFixed(2) : null,
  hold: +mount.progress.toFixed(3),
  speed: +mount.speed.toFixed(2),
  /** Which way the mount itself is pointing — NOT where a mounted cast goes. */
  yaw: mount.pal ? +Math.atan2(mount.pal.forward.x, mount.pal.forward.z).toFixed(3) : null,
  forward: mount.pal
    ? { x: +mount.pal.forward.x.toFixed(3), z: +mount.pal.forward.z.toFixed(3) }
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
    name: support().species.name,
    fetching: support().isFetching,
    carrying: support().isCarrying,
    item: support().fetchItemId,
    pos: { x: +support().position.x.toFixed(2), z: +support().position.z.toFixed(2) },
  },
  primary: { name: primary().species.name, fetching: primary().isFetching },
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
bus.emit({
  type: 'toast',
  // A touchscreen laptop driven by mouse gets the desktop hint: `touch` is
  // non-null there (it ticks the camera stick) but stays hidden until a touch.
  text: isTouchPrimary()
    ? 'Welcome to Cube Pals! Left stick moves, right stick looks.'
    : 'Welcome to Cube Pals! Click to play.',
});

// ?fps=<n> caps the frame rate (0 or absent = uncapped). F2 shows measured FPS.
const fpsCap = Number(params.get('fps') ?? 0);
engine.setFpsCap(fpsCap);
const debug = new DebugOverlay(engine.renderer, fpsCap);
if (params.get('debug') === '1') debug.toggle();

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
  help: 'Toggle collision volumes: green = solid, blue = climbable. Ground excluded.',
  run: (args) => {
    const on = args[0] === 'on' ? true : args[0] === 'off' ? false : !colliderView.isVisible;
    colliderView.setVisible(on);
    return on
      ? `colliders ON — ${colliderView.count} drawn (green solid, blue climb)`
      : 'colliders OFF';
  },
});
devConsole?.register({
  name: 'mount',
  args: '[off|<speciesId>]',
  help: 'Ride the primary pal without the 2s hold; /mount off dismounts.',
  run: (args) => {
    const arg = args[0];
    if (arg === 'off') {
      if (!mount.isMounted) return 'not mounted';
      const name = mount.pal!.species.name;
      mount.dismount();
      return `dismounted ${name}`;
    }
    if (mount.isMounted) return `already riding ${mount.pal!.species.name} — /mount off first`;
    if (arg) {
      const idx = roster.findIndex((p) => p.species.id === arg);
      if (idx < 0) return `no such pal "${arg}" — ${roster.map((p) => p.species.id).join(', ')}`;
      if (idx === supportIdx) supportIdx = primaryIdx;
      primaryIdx = idx;
      refreshVisibility();
    }
    const why = mount.refusal(primary());
    if (why !== 'none') return `cannot mount: ${why}`;
    mount.mount(primary());
    return `riding ${primary().species.name} (${primary().species.locomotion})`;
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
 * 14 links when the support pal first cast a skill at 7.2 s was followed at
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
  // drawn, and the materials that matter — terrain, props, water, pals, the
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

function simulate(dt: number, first: boolean, interactive: boolean): void {
  // An open console is a modal: it has the keyboard, so the hero must not also
  // act on it. Same treatment the shop already gets.
  const shopOpen = hud.isShopOpen() || !!devConsole?.isOpen;
  nearShop = false;
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
  // stream and the pals to animate — everything below the branch.
  if (!interactive) {
    // fall through to the world update
  } else if (!shopOpen) {
    perf.section('input');
    // Mounting runs BEFORE the player: while a pal is being ridden it writes
    // the hero's position, velocity and saddle pose for this slice, and
    // player.update() then animates and frames him from those. It is safe on
    // every slice — the F edge is latched inside the controller, not read from
    // input.pressed(). `flags.pals` gates it because a hidden party has nothing
    // to climb on.
    mount.update(dt, flags.pals ? primary() : null);
    player.update(dt);
    // The hero is the only thing that brushes the world today. A mount's gallop
    // dust would pass `mount.pal` here instead — same interface, same pool.
    toucher = player;
    perf.section('player');

    if (first) {
      // Hotbar
      const skills = hotbarSkills();
      (['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const).forEach((code, i) => {
        if (input.pressed(code) && skills[i]) castFromPal(primary(), skills[i]);
      });

      // Pal management. Swapping is locked out in the saddle: every mounted
      // path here keys off primary() being the ridden pal — the hotbar aims
      // from it, the follow update skips it — and a Tab mid-ride would make
      // "the pal you are riding" and "the pal you are commanding" two different
      // animals for no gain.
      if (mount.isMounted) {
        if (input.pressed('Tab') || input.pressed('BracketLeft') || input.pressed('BracketRight')) {
          bus.emit({ type: 'toast', text: 'Dismount first (tap F).' });
        }
      } else {
        if (input.pressed('Tab')) {
          const t = primaryIdx; primaryIdx = supportIdx; supportIdx = t;
          bus.emit({ type: 'toast', text: `${primary().species.name} takes the lead!` });
        }
        if (input.pressed('BracketRight')) cyclePal('primary', 1);
        if (input.pressed('BracketLeft')) cyclePal('support', 1);
      }
    }

    // Support pal errands + auto-cast
    const sup = support();

    fetchScanT -= dt;
    if (fetchScanT <= 0) {
      fetchScanT = FETCH_SCAN;
      if (flags.pals && !sup.isFetching && !sup.isDead) {
        const job = combat.findFetchJob(player.position, FETCH_RADIUS, worthFetching);
        if (job) sup.beginFetch(job);
      }
    }

    if (sup.wantsSupportCast()) {
      const known = sup.knownSkillIds.map((id) => getSkill(id)).filter((s): s is SkillDef => !!s);
      const heal = known.find((s) => s.targeting === 'support' || s.targeting === 'self');
      const hurt = player.hp < player.maxHp * 0.7 || primary().hp < primary().maxHp * 0.7;
      const pick = hurt && heal ? heal : known.find((s) => s.targeting !== 'support' && s.targeting !== 'self') ?? heal;
      if (pick) castFromPal(sup, pick);
    }

    // Shop proximity. The prompt itself is decided after the zone update below,
    // because a gateway prompt has to win: both are "you are standing on
    // something", and the gateway is the one with a countdown running.
    nearShop = world.shopPositions.some((s) => s.distanceTo(player.position) < 3.5);
    if (nearShop && first && input.pressed('KeyE')) tryOpenShop();
  } else if (first && (input.pressed('Escape') || input.pressed('KeyE'))) {
    hud.closeShop();
  }

  // Contact particles. Sits between the `player` and `pals` profiler markers, so
  // its cost is measured in the `pals` slot — its own timing is on
  // `__dbgTouchFx().ms`, which is finer grained than a section anyway.
  touchFx.update(dt, toucher);

  // Cooldowns
  for (const [id, t] of cooldowns) cooldowns.set(id, Math.max(0, t - dt));

  // Pals follow
  const owner = { position: player.position, velocity: player.velocity, isSwimming: player.isSwimming };
  if (flags.pals) {
    // The ridden pal has already been placed and animated by mount.update();
    // running follow steering on top of that would fight the reins.
    const ridden = mount.pal;
    if (primary() !== ridden) primary().update(dt, owner, 'primary', roster);
    if (support() !== ridden) support().update(dt, owner, 'support', roster);
  }
  perf.section('pals');

  // Streams the active zone, runs the gateway's arm/dwell rules, and builds and
  // warms whatever is being preloaded. It can swap `world` out from under this
  // slice (see onArrive), which is safe here: everything above has finished
  // with it, and combat below is rebound by the same call.
  zones.update(player.position, dt, first);
  perf.section('world');

  const hint = portalHint ?? (nearShop ? 'Press E — Skill Den' : null);
  if (hint) hud.showHint(hint);
  else hud.hideHint();

  combat.update(dt, player as unknown as Damageable, [primary(), support()] as unknown as Damageable[]);
  perf.section('combat');
}

function frame(): void {
  requestAnimationFrame(frame);
  if (!engine.beginFrame()) return;
  perf.begin();
  const dt = engine.tick();
  const shopOpen = hud.isShopOpen();

  // Drain the accumulator in fixed slices; carry the remainder to next frame.
  simAccumulator += dt;
  let steps = 0;
  while (simAccumulator >= SIM_DT && steps < MAX_STEPS) {
    simulate(SIM_DT, steps === 0, !photoMode);
    simAccumulator -= SIM_DT;
    steps++;
  }
  // Hit the cap: drop the backlog rather than compound it into the next frame.
  if (steps === MAX_STEPS) simAccumulator = 0;

  if (photoMode) {
    if (params.get('pal')) {
      // Auto-frame the primary pal: 3/4 portrait tracking its live position.
      const pal = primary();
      const ang = (Number(params.get('a') ?? 35) * Math.PI) / 180;
      // Frame the subject at ~40% of frame height. Sized from the rig's own
      // extents (a small pal's ears/tail push well past its nominal height, and
      // wingspan dominates for flyers) with a hard minimum distance: at 55° FOV
      // anything closer than ~2.6 units distorts badly on a wide-angle lens.
      const subject = Math.max(0.5, pal.height, pal.radius * 2.2);
      const vFov = (engine.camera.fov * Math.PI) / 180;
      const fitDist = subject / (0.4 * 2 * Math.tan(vFov / 2));
      const dist = Number(params.get('dist') ?? Math.max(2.6, fitDist));
      const midY = pal.position.y + subject * 0.5;
      const aimY = pal.position.y + subject * 0.42;

      /** Highest camera lift needed to clear terrain along the sight line. */
      const requiredLift = (px: number, pz: number, d: number): number => {
        let need = world.getHeight(px, pz) + 0.9;
        for (let s = 1; s <= 6; s++) {
          const t = s / 7;
          const gx = px + (pal.position.x - px) * t;
          const gz = pz + (pal.position.z - pz) * t;
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
          const tx = pal.position.x + Math.sin(a2) * d2;
          const tz = pal.position.z + Math.cos(a2) * d2;
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
      engine.camera.lookAt(pal.position.x, aimY, pal.position.z);
      // Turn the subject to face the camera, off by 20° for a 3/4 view. This
      // must use the FINAL bearing, not the requested `ang` — the occlusion
      // search above may have swung the camera, which is how subjects ended up
      // photographed from the flank.
      pal.facingOverride = Math.atan2(cx - pal.position.x, cz - pal.position.z) - 0.35;
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
  hud.setPals(palHud(primary()), palHud(support()));
  const slots: SkillSlot[] = hotbarSkills().map((def) => {
    const remaining = cooldowns.get(def.id) ?? 0;
    return { def, cooldownRemaining: remaining, ready: remaining <= 0 };
  });
  hud.setSkills(slots);
  hud.setMountHold(mount.progress);
  hud.setMounted(
    mount.pal ? mount.pal.species.name : null,
    mount.pal ? mount.pal.species.locomotion === 'flying' : false,
  );
  hud.update(dt);

  // Hide the touch overlay while a modal shop is open so it can't be tapped
  // through, and release any held virtual buttons.
  touch?.setVisible(!shopOpen);

  if (!started && (input.pointerLocked || input.touchActive)) {
    started = true;
    bus.emit({
      type: 'toast',
      text: touch?.isRevealed
        ? 'Left stick moves · right stick looks · ATK / JUMP / USE · 1-4 skills · SWAP'
        : 'WASD move · Space jump · LMB attack · 1-4 skills · hold F to ride · Tab swap · E shop',
    });
  }

  if (input.pressed('F2')) debug.toggle();
  colliderView.update(dt);
  perf.section('hud');

  // AFTER every camera decision this frame (the player controller's, or photo
  // mode's above) and before the render: the effect keys off where the lens
  // actually ends up, and a frame late is a frame of clear water at the surface.
  underwater.update(dt, world.isWater(engine.camera.position.x, engine.camera.position.z));

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
// enemy population and teleports the pals to the player, both of which are
// still at the origin (and so out of frame, and so uncompiled) before it.
if (params.get('warmup') !== '0') {
  simulate(SIM_DT, true, !photoMode);
  warmUpShaders();
}
frame();

// Profiler dump for the perf harness; null unless ?perf=1 recorded anything.
(window as unknown as { __dbgPerf: () => unknown }).__dbgPerf = () => perf.dump();

// World surface queries at an arbitrary column, for the climbing/collision
// tests: `ground` is what blocks and supports, `trunkSolidTop` is the bole a
// tree adds to that, and `climbTop` is what can be grabbed (bole or canopy).
// Read-only, and the whole point of the three being separate — see World.
(window as unknown as { __dbgWorld: (x: number, z: number) => unknown }).__dbgWorld = (x, z) => ({
  ground: world.getHeight(x, z),
  climbTop: world.climbTopAt(x, z),
  trunkSolidTop: world.trunkSolidTopAt(x, z),
});

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
// preserved the hero's hp and a pal's level is to read them either side of the
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
  pals: roster.map((p) => ({
    id: p.species.id,
    level: p.level,
    xp: p.xp,
    hp: +p.hp.toFixed(2),
    maxHp: p.maxHp,
    skills: p.knownSkillIds.slice(),
  })),
});
