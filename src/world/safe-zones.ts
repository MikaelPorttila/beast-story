/**
 * SAFE ZONES — the discs the wild population may not appear inside.
 *
 * The contract, and the argument for why a zone is a SPAWN rule rather than a
 * wall, is `SafeZone` in src/core/types.ts; read that first. This file is the
 * implementation and the two numbers that decide how big a town's disc is.
 *
 * ONE REGISTRY, FED BY EVERYTHING THAT CLAIMS GROUND. Towns register theirs from
 * their own geometry, skill dens from a constant, and a landmark from whatever
 * the composition root that placed it asked for — so the spawn path asks ONE
 * question rather than growing a clause per feature. That matters more than it
 * looks: the failure mode of a keep-out is invisible (a monster that did not
 * appear leaves nothing behind), so the thing to protect is the number of places
 * the rule is written down, which is one.
 */

import type { SafeZone, SafeZoneRegistry } from '../core/types';

/**
 * How far past a settlement's BUILT perimeter its keep-out reaches.
 *
 * Measured against the spawn ring in combat/index.ts: a candidate lands 25-60
 * units from the player, so a hero standing at the Encampment's fire has the
 * inner edge of that band 25 units out and the wall's corners at 23.76. With no
 * margin the first legal ring of ground is a metre past the palisade, which is
 * where a Snortle popping into existence still reads as "in the camp" from
 * inside it. 6 puts it 29.76 out for the camp and 21 for a hamlet — far enough
 * that an arrival happens in the meadow, near enough that the walk out of town
 * is still a walk toward something.
 *
 * It is added to `outerRadius` rather than to `radius` because the question is
 * about what you can SEE from the town, and what you can see from a town is
 * bounded by the thing that was built, not by the nominal circle.
 */
export const TOWN_NO_SPAWN_MARGIN = 6;

/**
 * The keep-out a SKILL DEN gets, and the reason it is 0.
 *
 * A den is the game's existing "point of interest" (`World.shopPositions`, and
 * see LandmarkProbe), and the requirement for one is that a designer sets it if
 * the place needs it — so the default is the feature switched off, and this
 * constant is the switch. A den is a counter in a clearing rather than somewhere
 * a player lives; buying a skill takes a few seconds and the meadow around it is
 * meant to have things in it. Raise it here (4.5 is the den's own flatten core,
 * 9 its blend) if a den ever becomes somewhere to stand still.
 */
export const DEN_NO_SPAWN_RADIUS = 0;

/** The linear-scan registry. See SafeZoneRegistry for why a scan is right. */
export class SafeZoneField implements SafeZoneRegistry {
  private readonly zones: SafeZone[] = [];

  get all(): readonly SafeZone[] {
    return this.zones;
  }

  add(id: string, x: number, z: number, radius: number): void {
    if (!(radius > 0)) return;
    this.zones.push({ id, x, z, radius });
  }

  blocksSpawn(x: number, z: number): boolean {
    // Squared distances and an index loop: this runs inside `trySpawn` and
    // inside every wanderer's goal pick, both of which are held to the file
    // rule that a spawn path allocates nothing.
    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i];
      const dx = zone.x - x;
      const dz = zone.z - z;
      if (dx * dx + dz * dz < zone.radius * zone.radius) return true;
    }
    return false;
  }
}

/**
 * The registry for a world that has none — the dungeon, the lab stage.
 *
 * Frozen and shared rather than a fresh `SafeZoneField` per caller, because
 * `add` on this one would silently succeed and then be dropped on the next zone
 * load; refusing to be a mutable empty is the honest shape. A world that wants
 * zones constructs a field.
 */
export const NO_SAFE_ZONES: SafeZoneRegistry = {
  all: Object.freeze([]) as readonly SafeZone[],
  blocksSpawn: () => false,
  add: () => {},
};
