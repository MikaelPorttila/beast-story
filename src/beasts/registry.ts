import type { BeastSpecies, SkillDef } from '../core/types';
import * as emberfox from './species/emberfox';
import * as aquaxol from './species/aquaxol';
import * as sproutle from './species/sproutle';
import * as sparkit from './species/sparkit';
import * as frostwing from './species/frostwing';
import * as boulderpup from './species/boulderpup';
import * as galebird from './species/galebird';
import * as umbrakit from './species/umbrakit';
import * as lumimoth from './species/lumimoth';
import * as drakelet from './species/drakelet';
// The water roster (issue #76). Two amphibians, two pure swimmers and a crab —
// see DEEP_WATER_DEPTH in world/terrain.ts for what they are for.
import * as rivotter from './species/rivotter';
import * as coralback from './species/coralback';
import * as finnick from './species/finnick';
import * as snapclaw from './species/snapclaw';
import * as lanternfin from './species/lanternfin';

const modules = [
  emberfox, aquaxol, sproutle, sparkit, frostwing,
  boulderpup, galebird, umbrakit, lumimoth, drakelet,
  rivotter, coralback, finnick, snapclaw, lanternfin,
];

export const ALL_SPECIES: BeastSpecies[] = modules.map((m) => m.species);

export const SKILLS: Map<string, SkillDef> = new Map();
for (const m of modules) {
  for (const s of m.skills) SKILLS.set(s.id, s);
}

export function getSkill(id: string): SkillDef | undefined {
  return SKILLS.get(id);
}
