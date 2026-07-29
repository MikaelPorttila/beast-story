import * as THREE from 'three';
import { Engine } from './core/engine';
import { DebugOverlay } from './core/debug-overlay';
import { Input } from './core/input';
import { TouchControls } from './core/touch';
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

    let best: THREE.Vector3 | null = null;
    let bestFlat = Infinity;
    for (const radius of [16, 21, 26, 31, 12]) {
      for (let k = -4; k <= 4 && !best; k++) {
        const a = ring + k * 0.26;
        const x = base.x + Math.cos(a) * radius;
        const z = base.z + Math.sin(a) * radius;
        if (world.getHeight(x, z) < world.waterLevel + 0.6) continue; // not in the shallows
        const f = flatness(x, z);
        if (f < bestFlat) { bestFlat = f; best = new THREE.Vector3(x, 0, z); }
        if (f < 0.7) break; // good enough, take it
      }
      if (bestFlat < 0.7) break;
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
  __dbgCamYaw: () => number;
}
(window as unknown as DebugProbes).__dbgPlayerPos = () => ({
  x: player.position.x, y: player.position.y, z: player.position.z,
});
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
  text: touch
    ? 'Welcome to Cube Pals! Drag the right side to look, stick to move.'
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
      const cx = pal.position.x + Math.sin(ang) * dist;
      const cz = pal.position.z + Math.cos(ang) * dist;
      // True eye level with the subject's mid-height: looking down made ground
      // pals read as specimens and hovering flyers look face-planted.
      const midY = pal.position.y + subject * 0.5;
      // ...but never inside or behind terrain. Clear the camera's own ground,
      // then walk the sight line and lift until nothing occludes the subject.
      const aimY = pal.position.y + subject * 0.42;
      let camY = Math.max(midY, world.getHeight(cx, cz) + 0.9);
      for (let s = 1; s <= 6; s++) {
        const t = s / 7;
        const gx = cx + (pal.position.x - cx) * t;
        const gz = cz + (pal.position.z - cz) * t;
        const clearance = world.getHeight(gx, gz) + 0.35;
        // camY must be high enough that the ray camY->aimY passes above `clearance`
        if (aimY + (camY - aimY) * (1 - t) < clearance) {
          camY = aimY + (clearance - aimY) / Math.max(0.15, 1 - t);
        }
      }
      engine.camera.position.set(cx, camY, cz);
      // Aim slightly low so the subject sits at ~0.45 frame height.
      engine.camera.lookAt(pal.position.x, aimY, pal.position.z);
      // Turn the subject to face the camera, off by 20° for a 3/4 view (the
      // camera's bearing from the pal is `ang`, so facing `ang` looks at it).
      pal.facingOverride = ang - 0.35;
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
      text: touch
        ? 'Stick moves · drag to look · ATK / JUMP / USE · 1-4 skills · SWAP pals'
        : 'WASD move · Space jump · LMB attack · 1-4 skills · Tab swap · ]/[ cycle pals · E shop',
    });
  }

  if (input.pressed('F2')) debug.toggle();

  engine.render();
  debug.update();
  input.endFrame();
}
frame();
