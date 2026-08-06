/**
 * Beast Story Lab — isolated model/actor/VFX stage.
 *
 * Renders ONE subject (or a lineup) on a neutral floor with no terrain
 * streaming, props, enemies, HUD or gameplay systems, so iteration and
 * screenshots are fast and deterministic. Anything tuned here MUST still be
 * verified in the real game (index.html) before it counts as done.
 *
 * URL parameters
 *   beast=<speciesId>      one beast (see src/beasts/registry.ts)
 *   beasts=all|a,b,c       lineup of beasts, evenly spaced
 *   enemy=gloopling|snortle|peckit
 *   hero=1                 the player character rig
 *   skill=<skillId>        fires that skill on a loop at a dummy target
 *   waterfall=1            a waterfall VFX on a bare stage
 *   fall=<units>           how far it falls before it is invisible (default 48)
 *   push=<units>           how far it is pushed sideways over that (default 3)
 *   spray=<n>              droplet budget (default 128, 0 = none)
 *   lean=<units/s>         fake a carrier's sideways motion, to see the trail
 *   anim=<BeastAction>     idle|walk|run|swim|fly|attack|cast|special|hurt|happy
 *   t=<seconds>            simulate this long, then render one frozen frame
 *                          (deterministic — use for screenshots)
 *   spin=1                 turntable the subject
 *   water=1                flood the stage (swim/amphibious testing)
 *   dist, height, angle    camera framing (units, units, degrees)
 *   bg=RRGGBB              backdrop colour
 *   grid=0                 hide the floor
 */
import * as THREE from 'three';
import { Engine } from '../core/engine';
import { DebugOverlay } from '../core/debug-overlay';
import { EventBus, type BeastAction, type Damageable } from '../core/types';
import { BeastActor, registerSkillDefs } from '../beasts/framework';
import { ALL_SPECIES, SKILLS, getSkill } from '../beasts/registry';
import { Enemy, type EnemyCtx } from '../combat/enemies';
import { VFX } from '../combat/vfx';
import { CombatSystem } from '../combat/index';
import { buildHeroRig } from '../player/hero-rig';
import { StubWorld } from './stub-world';
import { Waterfall } from '../world/waterfall';
import { bootstrapContent, content } from '../content';
// See the long note at the same import in src/main.ts: the provider is imported
// STATICALLY from the entry point so the bundler keeps `core.json` in this
// entry's own chunk rather than splitting it out behind a request.
import { BundledProvider } from '../content/storage/bundled';

// An enemy's stats, palettes and the NAME of its voxel builder are content
// (issue #60), so `?enemy=` cannot build one until the core package is in.
// `await` at the top of the module for the same reason src/main.ts has one, and
// unconditionally rather than only when `?enemy=` is present: the cost is one
// bundled JSON parsed out of the main chunk, and a lab that loaded content only
// on some URLs would be a lab whose boot order depends on the query string.
content.addProvider(new BundledProvider());
await bootstrapContent();

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = Number(params.get(k));
  return Number.isFinite(v) && params.get(k) !== null ? v : d;
};

const app = document.getElementById('app')!;
const engine = new Engine(app);
const bus = new EventBus();
registerSkillDefs(SKILLS.values());

// -- stage -------------------------------------------------------------------
const bg = params.get('bg');
if (bg) {
  const c = new THREE.Color(`#${bg}`);
  engine.scene.background = c;
  engine.scene.fog = null;
}
const flooded = params.get('water') === '1';
const world = new StubWorld(engine.scene, 0, flooded);
const labFloor = (): THREE.Object3D | undefined =>
  engine.scene.getObjectByName('lab:floor');
if (params.get('grid') === '0') {
  const floor = labFloor();
  if (floor) floor.visible = false;
}

// -- subjects ----------------------------------------------------------------
const beasts: BeastActor[] = [];
const marks: THREE.Vector3[] = [];
const enemies: Enemy[] = [];
let heroRoot: THREE.Group | null = null;
const subjectPos = new THREE.Vector3(0, 0, 0);
let subjectHeight = 1;
let lineupWidth = 0;

const beastsParam = params.get('beasts');
const beastParam = params.get('beast');
if (beastsParam) {
  const ids = beastsParam === 'all'
    ? ALL_SPECIES.map((s) => s.id)
    : beastsParam.split(',').map((s) => s.trim());
  const chosen = ALL_SPECIES.filter((s) => ids.includes(s.id));
  const spacing = num('spacing', 2.0);
  chosen.forEach((sp, i) => {
    const actor = new BeastActor(sp, engine.scene, world, bus);
    const x = (i - (chosen.length - 1) / 2) * spacing;
    actor.position.set(x, 0, 0);
    actor.facingOverride = 0; // face +Z, toward the camera
    beasts.push(actor);
    marks.push(new THREE.Vector3(x, 0, 0));
  });
  lineupWidth = (chosen.length - 1) * spacing;
  subjectHeight = 1.4;
} else if (beastParam) {
  const sp = ALL_SPECIES.find((s) => s.id === beastParam);
  if (sp) {
    const actor = new BeastActor(sp, engine.scene, world, bus);
    actor.facingOverride = 0;
    beasts.push(actor);
    marks.push(new THREE.Vector3(0, 0, 0));
    subjectHeight = 1.0;
  } else {
    console.error(`[lab] unknown beast "${beastParam}". Known:`, ALL_SPECIES.map((s) => s.id));
  }
}

const enemyParam = params.get('enemy');
const vfx = new VFX(engine.scene);
if (enemyParam === 'gloopling' || enemyParam === 'snortle' || enemyParam === 'peckit') {
  enemies.push(new Enemy(enemyParam, num('variant', 0), 0, 0, world));
  for (const e of enemies) engine.scene.add(e.root);
  subjectHeight = 1.2;
}

if (params.get('hero') === '1') {
  const rig = buildHeroRig();
  heroRoot = rig.root;
  engine.scene.add(rig.root);
  subjectHeight = 1.8;
}

// A waterfall on a bare stage. The one subject here that is neither a body nor
// a skill: it is a world VFX, and the lab is where its numbers get tuned before
// it is hung off a flying island where the capture path freezes its clock.
//
// The anchor sits at the origin and the water falls to -fall, so the floor is
// hidden unless `grid=1` asks for it — a plume drops THROUGH the stage.
let waterfall: Waterfall | null = null;
let labLean = 0;
if (params.get('waterfall') === '1') {
  const fall = num('fall', 48);
  waterfall = new Waterfall({
    // 0 by default, so the base look is the fall alone. `push=` is the knob
    // under test and it should be seen on its own, not mixed into the default.
    length: fall,
    lateralPush: num('push', 0),
    // THE LIP IS AT THE TOP AND THE WATER REACHES y=0. The lab's camera frames
    // a subject that STANDS on the origin (`subjectPos` is its feet), so a fall
    // hung from the origin drops straight out of the bottom of every shot.
    x: 0, y: fall, z: 0,
    bearing: 0,
    spray: num('spray', 128),
  });
  engine.scene.add(waterfall.group);
  labLean = num('lean', 0);
  if (params.get('grid') !== '1') {
    const floor = labFloor();
    if (floor) floor.visible = false;
  }
  subjectPos.set(0, 0, 0);
  subjectHeight = fall;
  // Wider than the plume by a good margin: `fitDist` frames the WIDTH, and what
  // has to fit here is the height.
  lineupWidth = fall * 1.55;
}

// Skill firing needs a combat system and a stationary dummy to aim at.
const skillDef = params.get('skill') ? getSkill(params.get('skill')!) : undefined;
let combat: CombatSystem | null = null;
let dummy: Damageable | null = null;
if (skillDef) {
  combat = new CombatSystem(engine.scene, world, bus);
  dummy = {
    position: new THREE.Vector3(0, 0.6, 6),
    hp: 9999, maxHp: 9999, isDead: false, faction: 'wild',
    // The stage dummy is a target to aim skills at, not a thing that reacts:
    // it soaks every hit and reports it landed, so the caster's own VFX and
    // damage numbers behave exactly as they do in the game.
    takeDamage: () => true,
  };
  subjectHeight = 1.4;
}

// -- camera ------------------------------------------------------------------
// Frame the whole lineup: fit its width to the horizontal FOV with margin.
const hFov = 2 * Math.atan(Math.tan((engine.camera.fov * Math.PI) / 360) * engine.camera.aspect);
const fitDist = lineupWidth > 0 ? (lineupWidth * 0.62) / Math.tan(hFov / 2) : 2.6;
const dist = num('dist', Math.max(2.6, fitDist));
const camHeight = num('height', lineupWidth > 0 ? subjectHeight * 0.75 : subjectHeight * 0.7);
// A lineup is shot straight on; a single subject gets a 3/4 view.
let angle = (num('angle', lineupWidth > 0 ? 0 : 28) * Math.PI) / 180;
const spin = params.get('spin') === '1';

function placeCamera(): void {
  engine.camera.position.set(
    subjectPos.x + Math.sin(angle) * dist,
    subjectPos.y + camHeight,
    subjectPos.z + Math.cos(angle) * dist,
  );
  engine.camera.lookAt(subjectPos.x, subjectPos.y + subjectHeight * 0.42, subjectPos.z);
}

// -- simulation --------------------------------------------------------------
const owner = {
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(),
  isSwimming: false,
  deepDiving: false,
};
const animParam = params.get('anim') as BeastAction | null;
let simTime = 0;
let skillTimer = 0;

const enemyCtx: EnemyCtx = {
  world, targets: [], vfx, time: 0,
  hit: () => {},
};

function step(dt: number): void {
  simTime += dt;

  for (let i = 0; i < beasts.length; i++) {
    const p = beasts[i];
    const mark = marks[i];
    // Keep each beast parked on its mark: the owner sits where the beast stands,
    // and horizontal drift from steering/separation is snapped back after the
    // update so a lineup stays a lineup (vertical motion stays free so flyers
    // still hover and swimmers still bob).
    // Single subject turns with the camera so it always presents a 3/4 view;
    // a lineup stays square to the lens.
    if (beasts.length === 1) p.facingOverride = angle - 0.35;
    owner.position.copy(p.position);
    p.update(dt, owner, 'primary', beasts);
    if (animParam && animParam !== 'idle') p.playAction(animParam, 0.9);
    p.position.x = mark.x;
    p.position.z = mark.z;
  }

  enemyCtx.time = simTime;
  for (const e of enemies) e.update(dt, enemyCtx);
  vfx.update(dt);
  // `lean=` fakes a carrier's per-slice step, which is the only way to drive
  // the trail-behind term on a stage with no carrier in it — and the only way
  // to see it at all, since the in-game capture path freezes it to zero.
  waterfall?.update(dt, labLean * dt, 0);

  if (combat && skillDef && dummy) {
    skillTimer -= dt;
    if (skillTimer <= 0) {
      skillTimer = Math.max(1.2, skillDef.cooldown);
      const origin = new THREE.Vector3(0, 1.0, 0);
      const dir = new THREE.Vector3().subVectors(dummy.position, origin).normalize();
      combat.cast({
        skill: skillDef,
        caster: { ...(dummy as Damageable), forward: dir } as never,
        origin, direction: dir, target: dummy, attackStat: 20,
      });
    }
    combat.update(dt, dummy, []);
  }

  if (spin) angle += dt * 0.6;
  engine.updateSunFocus(subjectPos);
}

// Deterministic mode: advance a fixed number of steps, render once, stop.
const freezeAt = params.get('t');
if (freezeAt !== null) {
  const target = Number(freezeAt) || 0;
  const FIXED = 1 / 60;
  for (let t = 0; t < target; t += FIXED) step(FIXED);
  placeCamera();
  engine.render();
  document.title = `Lab (frozen @ ${target}s)`;
} else {
  const cap = num('fps', 0);
  engine.setFpsCap(cap);
  const debug = new DebugOverlay(engine.renderer, cap);
  if (params.get('debug') === '1') debug.toggle();
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F2') return;
    e.preventDefault(); // never let the browser see F2
    debug.toggle();
  });

  const loop = (): void => {
    requestAnimationFrame(loop);
    if (!engine.beginFrame()) return;
    step(engine.tick());
    placeCamera();
    engine.render();
    debug.update();
  };
  loop();
}

// Console helper so agents can introspect what is available.
(window as unknown as { labInfo: () => void }).labInfo = () => {
  console.log('beasts:', ALL_SPECIES.map((s) => s.id).join(', '));
  console.log('enemies: gloopling, snortle, peckit');
  console.log('skills:', [...SKILLS.keys()].join(', '));
};
