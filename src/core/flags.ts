/**
 * Diagnostic toggles, read once from the URL.
 *
 * These exist to answer "what is this costing?" the only way that survives
 * argument: remove one thing, measure, put it back. post.ts already does this
 * for the render chain (`post=0`, `ao=`, `bloom=`); this is the same idea for
 * the world's contents and the actors in it.
 *
 *   props=0     no trees/boulders/grass in streamed chunks
 *   clouds=0    no cloud deck, no drifting motes
 *   water=0     no water surface meshes
 *   enemies=0   no wild spawns
 *   pals=0      no pal actors at all (nothing built, nothing updated)
 *   shadows=0   no shadow map
 *   view=<n>    chunk streaming radius, in chunks (default 5)
 *
 * They are diagnostics, not game settings: nothing outside a measurement run
 * should be setting them, and no gameplay code should branch on them beyond the
 * construction points below.
 */
const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

const on = (key: string): boolean => p.get(key) !== '0';

export const flags = {
  props: on('props'),
  clouds: on('clouds'),
  water: on('water'),
  enemies: on('enemies'),
  pals: on('pals'),
  shadows: on('shadows'),
  /** Streaming radius in chunks; null means "use the module default". */
  viewRadius: p.get('view') !== null ? Math.max(1, Number(p.get('view'))) : null,
};

/** True when any toggle is off its default — used to keep captures honest. */
export const anyFlagSet = (): boolean =>
  !flags.props || !flags.clouds || !flags.water || !flags.enemies
  || !flags.pals || !flags.shadows || flags.viewRadius !== null;
