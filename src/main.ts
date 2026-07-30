import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Input } from './core/input';
import { TouchControls, isTouchPrimary } from './core/touch';
import { EventBus, type SkillDef, type Damageable } from './core/types';
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

function refreshVisibility(): void {
  roster.forEach((p, i) => p.setVisible(i === primaryIdx || i === supportIdx));
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

function frame(): void {
  requestAnimationFrame(frame);
  if (!engine.beginFrame()) return;
  const dt = engine.tick();
  const shopOpen = hud.isShopOpen();

  // The camera stick is a rate control, so it must inject its look delta BEFORE
  // the player/camera update consumes mouseDX this frame — ticking it later in
  // the frame meant endFrame() wiped the delta before the camera ever saw it.
  if (!shopOpen) touch?.update(dt);

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
  } else if (!shopOpen) {
    player.update(dt);

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
      if (input.pressed('KeyE')) tryOpenShop();
    } else {
      hud.hideHint();
    }
  } else if (input.pressed('Escape') || input.pressed('KeyE')) {
    hud.closeShop();
  }

  // Cooldowns
  for (const [id, t] of cooldowns) cooldowns.set(id, Math.max(0, t - dt));

  // Pals follow
  const owner = { position: player.position, velocity: player.velocity, isSwimming: player.isSwimming };
  primary().update(dt, owner, 'primary', roster);
  support().update(dt, owner, 'support', roster);

  world.update(player.position, dt);
  combat.update(dt, player as unknown as Damageable, [primary(), support()] as unknown as Damageable[]);

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

  engine.render();
  debug.update();
  input.endFrame();
}
frame();
