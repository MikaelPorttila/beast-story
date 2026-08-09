import * as THREE from 'three';
import { NO_CARRIERS, NO_SITE, type CelestialState, type TownRegistry, type World } from '../core/types';
import { NO_SAFE_ZONES } from '../world/safe-zones';

/**
 * Minimal World implementation for the lab: a flat (optionally water-filled)
 * stage with no chunk streaming, no props and no shops. Everything that takes
 * a World — beasts, enemies, combat — runs against this unchanged, so behaviour
 * matches the real game minus the terrain itself.
 */
export class StubWorld implements World {
  /**
   * Bare stage: the flat floor is the only thing to hold onto. Equal to
   * getHeight, so the stage also has no one-way platforms — the player's canopy
   * support only engages where this stands clear of the ground.
   */
  climbTopAt(): number { return this.getHeight(); }

  /** The stage has no props, so nothing on it reacts to being walked through. */
  disturb(): void { /* no vegetation on the lab stage */ }
  /** Nothing to draw: the stage has no colliders but its floor. */
  debugColliders(): void { /* no colliders on the lab stage */ }
  debugStructures(): void { /* nor any structure boxes */ }
  /** The stage has no settlements, so nothing has worn its ground. */
  debugWear(): number { return 0; }
  debugPaths(): { paths: []; at: null } { return { paths: [], at: null }; }
  /** The stage has no network to add to. See `World.addPath`. */
  addPath(): {
    id: string; length: number; samples: number; note: null;
    nodes: never[]; refused: never[]; error: string;
  } {
    return {
      id: '', length: 0, samples: 0, note: null, nodes: [], refused: [],
      error: 'this zone has no path network',
    };
  }
  debugCarriedStreets(): { count: number; paved: number; clear: number[] } {
    return { count: 0, paved: 0, clear: [] };
  }
  debugRidges(): void { /* nor any roofs */ }
  /** Nor any road furniture: the stage has no roads. */
  debugFurniture(): Array<{ kind: string; x: number; z: number }> { return []; }
  /** ...nor any fences: the stage has no roads to line. See World.debugFences. */
  debugFences(): ReturnType<World['debugFences']> { return []; }
  debugCarriedTrees(): Array<{ x: number; z: number }> { return []; }
  /** No props on the stage, so there is never a trunk in the way. */
  trunkSolidTopAt(): number { return -Infinity; }
  /** The stage grows nothing, so there is nothing to keep out of anything. */
  readonly foliageSite = NO_SITE;

  /** The stage is bare floor: nothing is built on it to walk into. */
  structureTopAt(): number { return -Infinity; }
  /** No canopy on the stage either: nothing to brush leaves out of. */
  crownContactAt(): boolean { return false; }

  readonly waterLevel: number;
  readonly shopPositions: THREE.Vector3[] = [];
  /** The stage is not a place; it has no settlements. */
  readonly towns: TownRegistry = { all: [], roads: [], get: () => undefined, nearest: () => null };
  /** ...so nothing on it keeps a spawn out either. See World.safeZones. */
  readonly safeZones = NO_SAFE_ZONES;
  /** ...and nobody lives on it. See World.npcs. */
  readonly npcs = null;
  /** ...and nothing on it moves under your feet. See World.carriers. */
  readonly carriers = NO_CARRIERS;
  /** ...and nothing is built on it: the lab stages a model, not a settlement. */
  readonly debugSpawn = null;
  readonly spawnPoint = new THREE.Vector3(0, 0, 0);
  /**
   * The stage has nobody to stand beside, so the pose is the middle of the
   * floor facing +Z — which is where the lab has always put its subject, and
   * what `spawnPoint` alone used to mean here. See World.playerStart.
   */
  readonly playerStart = { position: this.spawnPoint, yaw: 0 };
  /** The stage is one mesh built in the constructor: nothing ever streams. */
  readonly chunksLoaded = 1;
  readonly streaming = false;
  readonly pendingChunks = 0;
  private disposables: Array<{ dispose(): void }> = [];
  private meshes: THREE.Mesh[] = [];

  /**
   * @param scene    stage scene
   * @param groundY  height of the flat floor
   * @param flooded  when true the floor sits below water level (swim testing)
   */
  constructor(scene: THREE.Scene, private groundY = 0, flooded = false) {
    this.waterLevel = flooded ? groundY + 1.6 : groundY - 50;
    this.spawnPoint.set(0, groundY, 0);

    // Checkerboard floor: neutral value, reads scale without stealing focus.
    const size = 64;
    const geo = new THREE.PlaneGeometry(size, size, size, size);
    geo.rotateX(-Math.PI / 2);
    const colors: number[] = [];
    const pos = geo.getAttribute('position');
    const a = new THREE.Color(0x8fa87f);
    const b = new THREE.Color(0x84a074);
    for (let i = 0; i < pos.count; i++) {
      const cx = Math.floor(pos.getX(i) + size / 2);
      const cz = Math.floor(pos.getZ(i) + size / 2);
      const c = (cx + cz) % 2 === 0 ? a : b;
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const floor = new THREE.Mesh(geo, mat);
    // Named so `grid=0` can find THIS mesh rather than whichever one happens to
    // be first in the scene — the engine puts its own sky and sun geometry in
    // before the stage is built.
    floor.name = 'lab:floor';
    floor.position.y = groundY;
    floor.receiveShadow = true;
    scene.add(floor);
    this.meshes.push(floor);
    this.disposables.push(geo, mat);

    if (flooded) {
      const wgeo = new THREE.PlaneGeometry(size, size);
      wgeo.rotateX(-Math.PI / 2);
      const wmat = new THREE.MeshStandardMaterial({
        color: 0x3fa7f5, transparent: true, opacity: 0.62, roughness: 0.25,
      });
      const water = new THREE.Mesh(wgeo, wmat);
      water.position.y = this.waterLevel;
      scene.add(water);
      this.meshes.push(water);
      this.disposables.push(wgeo, wmat);
    }
  }

  getHeight(): number {
    return this.groundY;
  }

  isWater(): boolean {
    return this.waterLevel > this.groundY;
  }

  /**
   * The stage's puddle is one flat plane a hand under the floor, so nothing on
   * it is ever four units down. See World.isDeepWater.
   */
  isDeepWater(): boolean { return false; }

  /** The stage has no weather: nothing on it is ever under snow. */
  snowCoverAt(): number { return 0; }

  update(): void {
    /* nothing streams in the lab */
  }

  /** The lab uses the engine's celestial rig; its bare stage has no consumers. */
  applyCelestial(_state: Readonly<CelestialState>): void { /* nothing local to tint */ }

  /** The stage has no lights of its own, so this is just the floor. */
  /**
   * No-op: the lab stage has no streamed chunks, so there is no grass, no prop
   * mesh and no water surface for the F3 panel to hide. It is on the `World`
   * contract because anything taking a World may call it.
   */
  setLayerVisible(): void { /* nothing streamed here */ }
  setFoliageDistance(): void { /* nothing grows on the lab stage */ }
  setTerrainDistance(): void { /* the lab has no streamed terrain */ }
  debugDistantTerrain(): null { return null; }
  /** The stage owns no effects: the lab adds its subject to the scene itself. */
  warmUpEffects(): void { /* nothing to link */ }
  /** The stage has no carriers, so no carried waterfall either. */
  debugSkyFall(): null { return null; }

  /** No-op for the same reason: the stage grows nothing to re-grow. */
  rebuildProps(): void { /* nothing streamed here */ }

  setVisible(v: boolean): void {
    for (const m of this.meshes) m.visible = v;
  }

  /** One floor mesh: there is nothing here worth spreading over frames. */
  disposeStep(): boolean {
    this.dispose();
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
