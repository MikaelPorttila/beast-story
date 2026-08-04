/**
 * MUSIC AS CONTENT — one asset per AREA, carrying the playlist that area loops.
 *
 * WHAT MOVED AND WHAT DID NOT, the same line every other type in here draws.
 * WHICH songs an area plays and in WHAT ORDER is a statement about what exists —
 * content. Streaming an `<audio>` element, shaping the fade envelope over
 * `currentTime`, retiring a track and unloading it are behaviour, and they stay
 * in `src/audio/music.ts`. A track is SELECTED by name (`"tracks": ["overworld"]`)
 * from the `music-track` factory kind, which is content/types.ts §4.6's rule: data
 * chooses a behaviour — here a resource — and never supplies one. That is also
 * what keeps a URL out of authored JSON, which matters more here than it looks:
 * a string field that reached an `<audio src>` would be a content package
 * choosing what the page fetches.
 *
 * THE ID IS THE AREA. `music:overworld` is what the `overworld` zone plays,
 * `music:hold` would be the dungeon's. No `area` field, because the id already
 * carries it and content/types.ts §4.2's whole argument is that a reference is
 * self-describing — a second field naming the area would be the same fact written
 * twice, and the two would eventually disagree.
 *
 * THE TITLE SCREEN IS NOT AN AREA AND IS DELIBERATELY NOT HERE. It plays before
 * any content has loaded (see the boot note in main.ts: `music.setScene('title')`
 * runs at line ~251 and `bootstrapContent()` at ~499), so a poster whose track
 * came from content would either play the fallback for half a second and then
 * swap, or hold the splash silent until a package resolved. Its track stays the
 * engine's, in `TRACKS` in audio/music.ts.
 *
 * TWO KINDS OF "NO MUSIC", AND THEY ARE NOT THE SAME STATEMENT. An area with NO
 * asset has not been thought about, and gets the FALLBACK — which is the whole
 * request this type exists to serve. An area with `"tracks": []` has been thought
 * about and the answer was silence. Before this file the dungeon was the second
 * case expressed as the first (audio/music.ts's header called a scene missing
 * from its map "a deliberate answer rather than a gap"), which was true only
 * while nothing else could be missing for the other reason.
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from '../types';
import { bool, list, obj, opt, readerFor, str } from '../schema';

/** The factory kind a `tracks` entry selects. `music-track/overworld`. */
export const MUSIC_TRACK_KIND = 'music-track';

/** A track name: the same narrow alphabet as the `name` half of an id. */
const TRACK_RE = /^[a-z][a-z0-9-]*$/;

/**
 * A ceiling on how many songs one area may name.
 *
 * A guard against untrusted JSON (spec §22) rather than a design opinion, like
 * every other range in these parsers. It is small because the cost is not the
 * array: the director holds one element at a time, but a 4096-entry playlist is
 * a package asking the game to keep 4096 URLs live for an area the player walks
 * through in a minute.
 */
const MAX_TRACKS = 32;

export interface MusicData {
  /**
   * The songs this area plays, IN ORDER, wrapping at the end. Each is a
   * registered `music-track` name.
   *
   * EMPTY IS LEGAL AND MEANS SILENCE — see the header. It is the only way to say
   * "this area has no music" now that an absent asset means something else.
   */
  readonly tracks: readonly string[];
  /**
   * This is the playlist an area with no asset of its own gets.
   *
   * A FLAG ON ONE ASSET rather than a reserved id, for the reason `TownData.start`
   * and `BiomeData.startArea` are flags: `music:default` would be a fact expressed
   * as a NAME, and a name is exactly as positional as an array index the moment
   * somebody adds an area actually called "default". `validate` below enforces
   * the invariant — exactly one — because a rule with no data structure behind it
   * has to be a check.
   */
  readonly fallback: boolean;
}

/**
 * Track names the engine has registered, or null when nothing has.
 *
 * Module-level and published by `defineFactory`, exactly as `knownLayouts` in
 * town.ts is, and with the same two properties: a kind nobody registered anything
 * for is not checked at all (which is what keeps a headless validation run from
 * reporting every area), and two runtimes in one process publish the union, which
 * can only ever make the check more permissive.
 */
let knownTracks: ReadonlySet<string> | null = null;

export function setKnownMusicTracks(names: Iterable<string>): void {
  knownTracks = new Set(names);
}

function parse(body: unknown, ctx: ParseCtx): MusicData | null {
  const r = readerFor(ctx);
  const b = obj(body, r);
  return {
    tracks: list(
      (v, c) => str(v, c, { min: 1, max: 64, pattern: TRACK_RE, what: 'a music track name' }),
      { max: MAX_TRACKS },
    )(b.tracks, r.at('tracks')),
    fallback: opt(b.fallback, r.at('fallback'), bool) ?? false,
  };
}

/**
 * A playlist points at no ASSET.
 *
 * Its `tracks` are factory names, not content ids, so they are deliberately not
 * refs: the graph is a graph of content, and a reference into it that resolved to
 * nothing would report as `dangling` forever. The check that a track exists is
 * `unknown-factory` in `validate` below, which is the same answer town.ts gives
 * for `layout`.
 */
function* refs(_data: MusicData): Iterable<ContentId> {
  // Nothing. An area that named the quest that unlocks its second song would put
  // it here, and the graph would pick it up with no other change.
}

function validate(asset: ContentAsset<MusicData>, ctx: ValidateCtx): void {
  if (knownTracks !== null) {
    asset.data.tracks.forEach((track, i) => {
      if (knownTracks!.has(track)) return;
      ctx.report({
        severity: 'error',
        code: 'unknown-factory',
        message: `no "${MUSIC_TRACK_KIND}/${track}" is registered`,
        field: `data.tracks[${i}]`,
        fix: `defineFactory("${MUSIC_TRACK_KIND}", "${track}", url), or use one that exists`,
      });
    });
  }

  // --- the whole-table rule -------------------------------------------------
  // Run ONCE, from the first playlist in load order, for the reason town.ts gives
  // at the same place: "there are two fallbacks" is one finding about the SET,
  // and reporting it from every member prints it N times under N asset ids while
  // the sink's dedupe on (code, assetId, field) can do nothing about it.
  const all = ctx.content.all<MusicData>('music');
  if (all.length === 0 || all[0].id !== asset.id) return;

  const fallbacks = all.filter((m) => m.data.fallback);
  if (fallbacks.length !== 1) {
    ctx.report({
      severity: 'error',
      code: 'bad-field',
      message: fallbacks.length === 0
        ? 'no music asset declares "fallback": true'
        : `${fallbacks.length} music assets declare "fallback": true (${fallbacks.map((m) => m.id).join(', ')})`,
      field: 'data.fallback',
      related: fallbacks.map((m) => m.id),
      fix: 'exactly one playlist is what an area with none of its own plays',
    });
    return;
  }

  // A WARNING RATHER THAN AN ERROR, because it is a legitimate thing to mean —
  // "areas nobody has scored are silent" — and the game runs perfectly either
  // way. It is worth saying out loud because it makes the fallback invisible:
  // every symptom of an empty fallback is identical to the symptom of the
  // resolver never being wired up at all.
  if (fallbacks[0].data.tracks.length === 0) {
    ctx.report({
      severity: 'warn',
      code: 'bad-field',
      assetId: fallbacks[0].id,
      message: 'the fallback playlist is empty, so an area with no music asset is silent',
      field: 'data.tracks',
      fix: 'name a track here, or ignore this if silence is what was meant',
    });
  }
}

export const MUSIC_TYPE: ContentTypeDef<MusicData> = {
  name: 'music',
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: 'music:new-area',
    schema: 1,
    data: { tracks: ['overworld'], fallback: false },
  },
};
