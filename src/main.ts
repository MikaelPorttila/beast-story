import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Input } from './core/input';
import { TouchControls, isTouchPrimary } from './core/touch';
import { EventBus, type SkillDef, type Damageable } from './core/types';
import { perf } from './core/profiler';
import { flags } from './core/flags';
import { createWorld } from './world/index';
import { Player } from './player/index';
import { PalActor, registerSkillDefs } from './pals/framework';
import { CombatSystem } from './combat/index';
import { HUD, type PalHudInfo, type ShopOffer, type SkillSlot } from './ui/index';
import { ALL_SPECIES, SKILLS, getSkill } from './pals/registry';

const app = document.getElementById('app')!;
const engine = new Engine(app);
const input = new Input(engine.renderer.domElement);
const bus = new EventBus();

const world = createWorld(engine.scene, 1337);
const player = new Player(engine, world, input, bus);
const combat = new CombatSystem(engine.scene, world, bus);
const hud = new HUD(bus);

player.position.copy(world.spawnPoint);
player.onAttack = (origin, dir) => combat.meleeStrike(origin, dir, player.attackStat);

// ---------------------------------------------------------------------------
// Pal roster: all 10 species instantiated; two active at a time.
// ---------------------------------------------------------------------------
registerSkillDefs(SKILLS.values());
const roster: PalActor[] = ALL_SPECIES.map(
  (sp) => new PalActor(sp, engine.scene, world, bus),
);
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
bus.on((e) => {
  if (e.type === 'shardsChanged') {
    pickupTotal = e.total;
    hud.setShards(shards());
  }
  if (e.type === 'enemyKilled') {
    primary().gainXp(e.xp);
    support().gainXp(Math.round(e.xp * 0.6));
  }
});
hud.setShards(shards());

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------
function castFromPal(pal: PalActor, skill: SkillDef): void {
  const cd = cooldowns.get(skill.id) ?? 0;
  if (cd > 0) return;
  const target = combat.findNearestEnemy(pal.position, Math.max(skill.range, 12));
  if (target) {
    pal.forward.copy(target.position).sub(pal.position).setY(0).normalize();
  }
  const { origin, direction } = pal.beginCast(skill);
  const dir = target
    ? new THREE.Vector3().copy(target.position).sub(origin).normalize()
    : direction;
  combat.cast({
    skill,
    caster: pal as unknown as Damageable & { forward: THREE.Vector3 },
    origin,
    direction: dir,
    target,
    attackStat: pal.stats.attack,
  });
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
  __dbgCam: () => { x: number; y: number; z: number; pitch: number };
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
  isSwimming: player.isSwimming,
  isDead: player.isDead,
});

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
function warmUpShaders(): void {
  const camPos = engine.camera.position.clone();
  const camQuat = engine.camera.quaternion.clone();

  // The camera has to be looking at the REAL WORLD, not at an empty staging
  // area. The light sweep below only recompiles materials that are actually
  // drawn, and the materials that matter — terrain, props, water, pals, the
  // shop — are the world's. An earlier version staged this 400 units under the
  // map, which warmed the effects beautifully and left every lit surface in the
  // game to recompile later; the 12-program burst simply moved.
  const stage = world.spawnPoint.clone();
  stage.y += 1;
  engine.camera.position.set(stage.x, stage.y + 2, stage.z + 8);
  engine.camera.lookAt(stage);

  // One of everything, drawn once. This also takes the first pool light (the
  // projectile's), so the sweep below starts from a count of 1.
  combat.warmUp(stage, 0);
  engine.render();

  // Then one light at a time, one render each, to the pool's cap. EXACTLY one:
  // adding two per pass leaves every odd count uncompiled, which is a real bug
  // this code already had — three projectiles in flight at once then hit an
  // unseen count mid-fight and recompiled twelve materials in one frame.
  const POOL = 10; // VFX light pool cap
  for (let i = 1; i < POOL; i++) {
    combat.warmUpLight(stage);
    engine.render();
  }

  // NOT renderer.compile(scene, camera). It was tried and measured: it linked
  // 117 programs in one go and made boot dramatically WORSE (593 ms, 429 ms and
  // 287 ms stalls in the first 1.5 s, against ~110 ms without it), because it
  // links every permutation in the graph whether or not it will ever be drawn,
  // and the driver then compiles the lot. Drawing one of each thing, as above,
  // is both cheaper and closer to what the GPU actually needs.

  // Expire everything the warm-up spawned: every effect above was given a life
  // measured in hundredths of a second, so one long update clears the lot.
  combat.update(5, player as unknown as Damageable, []);

  engine.camera.position.copy(camPos);
  engine.camera.quaternion.copy(camQuat);
}

function simulate(dt: number, first: boolean, interactive: boolean): void {
  const shopOpen = hud.isShopOpen();

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
    player.update(dt);
    perf.section('player');

    if (first) {
      // Hotbar
      const skills = hotbarSkills();
      (['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const).forEach((code, i) => {
        if (input.pressed(code) && skills[i]) castFromPal(primary(), skills[i]);
      });

      // Pal management
      if (input.pressed('Tab')) {
        const t = primaryIdx; primaryIdx = supportIdx; supportIdx = t;
        bus.emit({ type: 'toast', text: `${primary().species.name} takes the lead!` });
      }
      if (input.pressed('BracketRight')) cyclePal('primary', 1);
      if (input.pressed('BracketLeft')) cyclePal('support', 1);
    }

    // Support pal auto-cast
    const sup = support();
    if (sup.wantsSupportCast()) {
      const known = sup.knownSkillIds.map((id) => getSkill(id)).filter((s): s is SkillDef => !!s);
      const heal = known.find((s) => s.targeting === 'support' || s.targeting === 'self');
      const hurt = player.hp < player.maxHp * 0.7 || primary().hp < primary().maxHp * 0.7;
      const pick = hurt && heal ? heal : known.find((s) => s.targeting !== 'support' && s.targeting !== 'self') ?? heal;
      if (pick) castFromPal(sup, pick);
    }

    // Shop proximity
    const near = world.shopPositions.some((s) => s.distanceTo(player.position) < 3.5);
    if (near) {
      hud.showHint('Press E — Skill Den');
      if (first && input.pressed('KeyE')) tryOpenShop();
    } else {
      hud.hideHint();
    }
  } else if (first && (input.pressed('Escape') || input.pressed('KeyE'))) {
    hud.closeShop();
  }

  // Cooldowns
  for (const [id, t] of cooldowns) cooldowns.set(id, Math.max(0, t - dt));

  // Pals follow
  const owner = { position: player.position, velocity: player.velocity, isSwimming: player.isSwimming };
  if (flags.pals) {
    primary().update(dt, owner, 'primary', roster);
    support().update(dt, owner, 'support', roster);
  }
  perf.section('pals');

  world.update(player.position, dt, first);
  perf.section('world');
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
        : 'WASD move · Space jump · LMB attack · 1-4 skills · Tab swap · ]/[ cycle pals · E shop',
    });
  }

  if (input.pressed('F2')) debug.toggle();
  perf.section('hud');

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
