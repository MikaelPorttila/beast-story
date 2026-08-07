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
 *   fence=<demo>           the paths and fences stage (see src/lab/paths-stage.ts):
 *                          slope|turn|ring|gate|variants|bridge|all
 *   orbs=1                 the four taming orbs in a row, turning
 *   gap=<units>            spacing between them (default: 1.5 diameters)
 *   scale=<n>              how big each one is drawn (default 2.4)
 *   follow=1               the owner teleports around the stage and the beasts
 *                          chase it, instead of standing on their marks
 *   jump=<seconds>         how often it teleports (default 1.2)
 *   reach=<units>          how far away it reappears (default 14)
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
import { tameOrbMesh, ORB_RADIUS } from '../combat/tame-orb';
import { ITEMS, ORB_IDS } from '../core/items';
import { buildHeroRig } from '../player/hero-rig';
import { StubWorld } from './stub-world';
import { buildPathsStage, groundAt, stageFraming } from './paths-stage';
import { FENCE_POST_H, FENCE_POST_R, FENCE_RAIL_AT } from '../world/town-parts';
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

/**
 * `?orbs=1` — the four taming orbs in a row, turning.
 *
 * A LINEUP AND NOT ONE ORB, because the four differ in exactly one thing and the
 * only useful question about them is whether that difference reads. Four spheres
 * side by side answer it in a single frame; four separate captures answer it
 * only if you can remember the last one.
 *
 * They spin on their own axis rather than being carried past the lens: what is
 * being looked at is the seam, the catch and the lit eye, and all three are on
 * the surface — see the header of src/combat/tame-orb.ts.
 */
const orbLineup: THREE.Object3D[] = [];
if (params.get('orbs') === '1') {
  const scale = num('scale', 2.4);
  // DERIVED FROM THE MODEL, not typed in: the default gap is one and a half
  // diameters at whatever size they are being drawn, so the four never
  // interpenetrate however `scale=` is set. The first version hard-coded 0.55
  // against a diameter of 0.67 and the capture came back as one fused lump.
  const d = ORB_RADIUS * 2 * scale;
  const gap = num('gap', d * 1.5);
  const rise = ORB_RADIUS * scale + 0.05;
  const defs = ORB_IDS.map((id) => ITEMS[id]);
  const span = (defs.length - 1) * gap;
  defs.forEach((def, i) => {
    const m = tameOrbMesh(def.color).clone();
    m.scale.setScalar(scale);
    m.position.set(-span / 2 + i * gap, rise, 0);
    engine.scene.add(m);
    orbLineup.push(m);
  });
  subjectPos.set(0, rise, 0);
  subjectHeight = d;
  lineupWidth = span + d;
}

/**
 * `?fence=<demo>` — the paths and fences stage (src/lab/paths-stage.ts).
 *
 * The one lab subject that is a piece of the WORLD rather than a body: a road,
 * a bridge deck and a fence, over a ground field four lines long. It replaces
 * the only way there was to look at either — load the game, walk to the one
 * bridge the seed built — and it is what `tools/test-fence.mjs` measures.
 *
 * The stage brings its own ground, so the checkerboard floor goes.
 */
const fenceParam = params.get('fence');
if (fenceParam) {
  const floor = labFloor();
  if (floor) floor.visible = false;
  const stage = buildPathsStage(engine.scene, fenceParam);
  const frame = stageFraming(fenceParam);
  subjectPos.copy(frame.at);
  subjectHeight = 3;
  lineupWidth = frame.dist;
  // The stage's ground field itself, so a probe can re-sample what the builder
  // measured instead of taking the builder's word for it. See test-fence.
  (window as unknown as { __dbgStageGround: (x: number, z: number) => number })
    .__dbgStageGround = groundAt;
  // Every post and every bay, in world coordinates. The fence invariant is a
  // statement about numbers — a plank's ends inside the posts it joins, at a
  // height both carry — so the probe reads them rather than a picture.
  (window as unknown as { __dbgFence: () => unknown }).__dbgFence = () => ({
    demo: fenceParam,
    fences: stage.fences.map(({ label, fence: f }) => ({
      label,
      posts: f.posts.map((p) => ({
        x: r3(p.x), z: r3(p.z), y: r3(p.y), base: r3(p.base), yaw: r3(p.yaw), kind: p.kind,
        // The stage's own ground under the post, so a probe can say "this stake
        // is planted" without a second copy of the height field.
        ground: r3(groundAt(p.x, p.z)),
      })),
      closed: f.closed,
      bays: f.bays.map((b) => ({
        from: b.from, to: b.to, length: r3(b.length), y: r3(b.y),
        groundMax: r3(b.groundMax),
      })),
    })),
    /** Deck samples, so a probe can find the span without routing a road. */
    road: stage.road ? stage.road.pts.map((p) => ({
      x: r3(p.x), z: r3(p.z), y: r3(p.y), bridge: p.bridge,
    })) : null,
    /** The kit's own metrics — what "inside the post" and "under the top" mean. */
    kit: { postH: FENCE_POST_H, railAt: [...FENCE_RAIL_AT], postR: FENCE_POST_R },
    /** Downward-facing triangles in the road mesh: the bridge soffit. */
    soffit: countSoffit(engine.scene),
  });
}

/** Three decimals is a millimetre — plenty for a fence, and readable in JSON. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * How many triangles of the road mesh face DOWN, and how far under the deck
 * the lowest of them sits.
 *
 * The bridge's underside is the other half of issue #105, and "is there a floor
 * on this bridge" is not a question a screenshot answers reliably — the deck is
 * lit from above, so a missing soffit reads as shadow until the camera is in
 * exactly the wrong place. Counting the down-facing triangles answers it in a
 * number: zero of them is the bug, and the count is the span's own length.
 */
function countSoffit(scene: THREE.Scene): { tris: number; minY: number } {
  let tris = 0;
  let minY = Infinity;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.name.startsWith('road:')) return;
    const nrm = m.geometry.getAttribute('normal');
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.getIndex();
    if (!nrm || !idx) return;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i);
      if (nrm.getY(a) >= -0.5) continue;
      tris++;
      for (let k = 0; k < 3; k++) {
        const y = pos.getY(idx.getX(i + k));
        if (y < minY) minY = y;
      }
    }
  });
  return { tris, minY: Number.isFinite(minY) ? Math.round(minY * 1000) / 1000 : 0 };
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

/**
 * `follow=1` — THE OWNER MOVES, so the beasts chase it.
 *
 * Every other mode on this stage parks each beast on its mark and puts the
 * owner underneath it, which is what makes a lineup a lineup and a screenshot
 * reproducible. It also means `moveSpeed` never leaves 0, so the one thing a
 * follower does that a parked model cannot show — slamming from a standstill
 * into full catch-up and back — does not happen here at all.
 *
 * This mode teleports the owner instead: it sits still for `jump` seconds, then
 * appears `reach` units away, and the beasts steer after it. That is the same
 * provocation tools/test-beastanim.mjs drives in the game with `__dbgTp`, minus
 * the world — and unlike the game it can do it to EVERY species at once
 * (`?beasts=all&follow=1`), where the game only ever has two in follow slots.
 *
 * Successive jumps step by the golden angle so the circuit never repeats a
 * bearing, and `velocity` is zeroed on arrival because a teleport is not a
 * movement — a follower that predicted ahead from a stale velocity would be
 * chasing a point the owner was never heading for.
 */
const chase = params.get('follow') === '1';
const CHASE_JUMP_S = num('jump', 1.2);
const CHASE_REACH = num('reach', 14);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
let chaseIn = CHASE_JUMP_S;
let chaseN = 0;

function moveOwner(dt: number): void {
  chaseIn -= dt;
  if (chaseIn > 0) return;
  chaseIn = CHASE_JUMP_S;
  const a = GOLDEN_ANGLE * chaseN++;
  owner.position.set(Math.sin(a) * CHASE_REACH, 0, Math.cos(a) * CHASE_REACH);
  owner.velocity.set(0, 0, 0);
}

const enemyCtx: EnemyCtx = {
  world, targets: [], vfx, time: 0,
  hit: () => {},
};

function step(dt: number): void {
  simTime += dt;

  if (chase) {
    moveOwner(dt);
    // No mark, no facing override: the point of this mode is where the steering
    // takes them. The camera rides the owner so the pack stays in frame.
    for (const p of beasts) p.update(dt, owner, 'primary', beasts);
    subjectPos.copy(owner.position);
  } else {
    for (let i = 0; i < beasts.length; i++) {
      const p = beasts[i];
      const mark = marks[i];
      // Keep each beast parked on its mark: the owner sits where the beast
      // stands, and horizontal drift from steering/separation is snapped back
      // after the update so a lineup stays a lineup (vertical motion stays free
      // so flyers still hover and swimmers still bob).
      // Single subject turns with the camera so it always presents a 3/4 view;
      // a lineup stays square to the lens.
      if (beasts.length === 1) p.facingOverride = angle - 0.35;
      owner.position.copy(p.position);
      p.update(dt, owner, 'primary', beasts);
      if (animParam && animParam !== 'idle') p.playAction(animParam, 0.9);
      p.position.x = mark.x;
      p.position.z = mark.z;
    }
  }

  enemyCtx.time = simTime;
  for (const e of enemies) e.update(dt, enemyCtx);
  vfx.update(dt);
  // `lean=` fakes a carrier's per-slice step, which is the only way to drive
  // the trail-behind term on a stage with no carrier in it — and the only way
  // to see it at all, since the in-game capture path freezes it to zero.
  waterfall?.update(dt, labLean * dt, 0);
  // Every orb on the same phase, so the four catches line up and a difference
  // between two of them is a difference in the MODEL rather than in the moment.
  for (const m of orbLineup) m.rotation.set(0, simTime * 1.1, simTime * 0.35);

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

/** The stage's fixed step, shared by the freeze path and `__dbgLabAdvance`. */
const SIM_STEP = 1 / 60;

/**
 * ADVANCE THE STAGE WITHOUT WAITING FOR IT — the lab's half of main.ts's
 * `__dbgAdvance`, and the reason a probe on this stage costs seconds rather
 * than minutes.
 *
 * Nothing here is rendered: `step()` is state, and every rig pose a probe reads
 * through `__dbgBeastAnim` (src/beasts/framework.ts) is written by
 * `BeastActor.update`. So a run that wants thirty seconds of session clock —
 * which tools/test-beastanim.mjs does, because the phase error of a
 * `time * freq` cycle scales with elapsed time — can have it in one call
 * instead of thirty seconds of wall clock and a rendered frame it never looks
 * at. Called with one step's worth it is a single-step driver, which is how a
 * probe samples every frame of a cycle with no rAF and no frame-rate to be
 * flaky about.
 *
 * PAIR IT WITH `t=0`, which renders one frame and starts no rAF loop, so this
 * is the only thing advancing the clock and two runs give the same numbers.
 * Clamped to 300 simulated seconds for the same reason `__dbgAdvance` is: the
 * burst blocks the main thread and a runaway argument must not hang the tab.
 */
(window as unknown as { __dbgLabAdvance: (seconds: number) => unknown })
  .__dbgLabAdvance = (seconds) => {
    const s = Math.min(Math.max(0, Number(seconds) || 0), 300);
    const slices = Math.round(s / SIM_STEP);
    const t0 = performance.now();
    for (let i = 0; i < slices; i++) step(SIM_STEP);
    return { slices, simSeconds: s, wallMs: +(performance.now() - t0).toFixed(1) };
  };

// Deterministic mode: advance a fixed number of steps, render once, stop.
const freezeAt = params.get('t');
if (freezeAt !== null) {
  const target = Number(freezeAt) || 0;
  const FIXED = SIM_STEP;
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
