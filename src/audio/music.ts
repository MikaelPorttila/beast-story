import titleUrl from './title.webm';
import overworldUrl from './overworld.webm';

/**
 * THE MUSIC — one track at a time, faded at both ends, unloaded on the way out.
 *
 * WHY THIS IS NOT src/feedback/audio.ts. That file is the SFX seam: short cues
 * fired off the event bus, mixed beside the rumble, drained on the frame the
 * thing happened. Music is the opposite in every dimension that matters — it is
 * one long stream, it belongs to a SCENE rather than to an event, and the only
 * thing that ever changes it is the player walking from one part of the game
 * into another. Two subsystems, and neither wants the other's shape.
 *
 * IT IS THE ONE PLACE IN THE PROJECT THAT LOADS SOUND FROM A FILE, and that is
 * the same exception the title screen's painting is (see AGENTS.md). Everything
 * the RENDERER draws is still generated in code; a composed song is not
 * something a few oscillators are a cheaper version of, it is a recording, and
 * `feedback/audio.ts`'s "whatever lands here should be generated" is about the
 * cues it owns — a sword hit, a level-up — and stays true of them.
 *
 * WHY AN <audio> ELEMENT AND NOT THE WEB AUDIO API
 *
 * The tracks are 1.3 MB and 2.4 MB of Opus. `AudioContext.decodeAudioData`
 * would hold both DECODED in memory — 85 s and 210 s of 48 kHz stereo float is
 * about 65 MB and 160 MB — and would decode them in one go on a thread we do
 * not control, during a boot this project has already spent a lot of effort
 * making incremental. An `<audio>` element streams, starts on the first few
 * kilobytes, and drops the lot when it is unloaded. Nothing here needs a
 * filter, a pan or a sample-accurate schedule; it needs a volume and a fade,
 * and `HTMLMediaElement.volume` is exactly that. It also has no context to get
 * stuck in `suspended`, which is the failure mode feedback/audio.ts's header
 * warns about at length.
 *
 * THE FADES ARE AN ENVELOPE OVER `currentTime`, NOT A SCHEDULE
 *
 * Both tracks are cut rough — they start and end mid-phrase — so looping one
 * raw puts a click in the player's ear every 85 seconds. The element loops
 * natively (`loop = true`, so the wrap is the browser's and costs nothing), and
 * a 50 ms timer shapes the volume from `currentTime`: up over `FADE_IN` at the
 * head, down over `FADE_OUT` at the tail, so the two meet at the loop point and
 * the seam is a dip rather than an edge.
 *
 * A timer rather than the frame loop, deliberately. `frame()` does not run
 * while the title screen is up (see the boot note in main.ts) and that is
 * exactly when the first track is playing, so a per-frame envelope would be a
 * per-frame envelope that never ticks. Timer jitter under a long task costs a
 * fade its smoothness at the tens-of-ms scale, which is inaudible inside a fade
 * measured in whole seconds.
 *
 * NOTHING IS LOADED AT VOLUME ZERO. `setVolume(0)` unloads whatever is playing
 * and `setScene` at zero starts nothing — no element, no request, no buffer.
 * That is the issue's requirement and it is also what makes a muted probe run
 * cost nothing at all: `?vol=0` is the whole of it (core/flags.ts).
 *
 * A BROWSER WILL NOT LET A PAGE MAKE NOISE BEFORE IT IS TOUCHED. `play()`
 * returns a promise that REJECTS when the autoplay policy refuses, and that is
 * a normal outcome on a fresh load, not an error: the title screen comes up
 * before anyone has clicked anything. A refusal arms one-shot listeners that
 * retry on the first real gesture, so the music starts on the same press that
 * takes the player off the splash.
 */

/**
 * A part of the game that has its own music. Not the same list as the zones —
 * the title screen is not a zone, and a zone with no track (the dungeon today)
 * is silence rather than a missing entry.
 */
export type MusicScene = 'title' | 'overworld' | 'hold' | null;

/** Which file each scene plays. A scene absent from this map is SILENT. */
const TRACKS: Partial<Record<Exclude<MusicScene, null>, string>> = {
  title: titleUrl,
  overworld: overworldUrl,
};

/**
 * Seconds of fade at the head and the tail of every pass through a track.
 *
 * The tail is the longer of the two because the cut is the audible half: both
 * tracks end mid-bar, and a fade that is still at a third of its volume when
 * the wrap comes reads as the click it was meant to hide. The head can be
 * shorter — a phrase arriving from silence is a phrase arriving, and a slow one
 * makes a player who just pressed New Game think the sound is broken.
 *
 * Measured against the tracks themselves: title 85.0 s, overworld 210.0 s, so
 * the shaped part is under 5% of either pass.
 */
const FADE_IN = 1.6;
const FADE_OUT = 2.6;

/** Seconds to fade the outgoing track when the SCENE changes. */
const FADE_SWAP = 0.9;

/** How often the envelope is recomputed, ms. See the header for why a timer. */
const TICK_MS = 50;

/**
 * How long to keep asking a refused `play()`, ms after the last gesture.
 *
 * Not a retry loop: each gesture gets exactly one attempt. This is the cap on
 * how long the LISTENERS stay armed, so a page nobody ever touches does not
 * carry three capture-phase listeners for the rest of the session.
 */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

const clamp01 = (v: number): number => (v > 1 ? 1 : v < 0 ? 0 : v);

export class MusicDirector {
  private el: HTMLAudioElement | null = null;
  private scene: MusicScene = null;
  /** The track URL currently loaded, or null. Also "is anything loaded". */
  private track: string | null = null;
  private master: number;
  /**
   * The SWAP ramp, 0..1, multiplied into the loop envelope. 1 while a track is
   * simply playing; walked down to 0 to retire one, which is when it unloads.
   */
  private swap = 1;
  private swapTarget = 1;
  /** Set while `swap` is on its way to 0: what to play once it gets there. */
  private pending: MusicScene = null;
  private timer = 0;
  /** The last `play()` was refused by the autoplay policy; waiting for a gesture. */
  private blocked = false;
  private listening = false;
  /** Diagnostics only — see `debugState`. */
  private loops = 0;
  private starts = 0;

  /**
   * @param volume 0..1. Zero is a real state, not a degenerate one: nothing is
   *   constructed, nothing is fetched, and `setVolume` above zero later starts
   *   whatever scene is current.
   */
  constructor(volume: number) {
    this.master = clamp01(volume);
  }

  /** The master volume as this director last had it. */
  get volume(): number { return this.master; }

  /**
   * Move to a part of the game. Idempotent — the common call is the same scene
   * it already has, and re-entering the overworld from the dungeon is not.
   *
   * The outgoing track is faded and then UNLOADED, which is the issue's "stop
   * and unload on scene transition": `pause()` alone leaves a decoder, a buffer
   * and a live connection behind for a track nothing is going to play again.
   */
  setScene(scene: MusicScene): void {
    if (scene === this.scene && this.pending === null) return;
    this.scene = scene;
    const want = scene === null ? undefined : TRACKS[scene];

    // Same file either side of the change (nothing does this today, but a second
    // outdoor zone would): keep playing rather than restarting the song.
    if (want && want === this.track) { this.pending = null; this.swapTarget = 1; return; }

    // Nothing loaded, or what IS loaded never got to play — the autoplay policy
    // refused it, which on a cold load is the normal state of the title track
    // right up until the click on New Game. There is nothing to fade out of: a
    // ramp here would spend 0.9 s retiring silence, and then `unlock` firing off
    // the same gesture would make that silence audible on the way out.
    if (!this.track || this.blocked) { this.pending = null; this.start(want ?? null); return; }
    // Something is playing: ramp it out first. `pending` is what `tick` starts
    // once the ramp lands, so two scene changes inside one fade resolve to the
    // last one asked for rather than to a queue.
    this.pending = scene;
    this.swapTarget = 0;
  }

  /**
   * Set the master volume, 0..1. Zero stops and unloads AT ONCE.
   *
   * No fade on the way to zero, and that is the point rather than an oversight:
   * a player reaching for mute wants silence now, and a second of politeness is
   * a second of the thing they just asked to stop. Coming back UP starts the
   * scene's track from its head, with its own fade in.
   */
  setVolume(v: number): void {
    const next = clamp01(v);
    const was = this.master;
    this.master = next;
    if (next === 0) { this.unload(); return; }
    if (was === 0) { this.start(this.scene === null ? null : TRACKS[this.scene] ?? null); return; }
    this.apply();
  }

  /**
   * A real user gesture happened, so a refused `play()` may be worth retrying.
   *
   * Safe to call at any time and from anywhere — it does nothing unless a play
   * was actually blocked. Public because the host knows about gestures this
   * module cannot see (a pad press routed through `Input`, a menu button
   * activated by Enter), and hearing about one costs a branch.
   */
  unlock(): void {
    if (this.blocked) this.tryPlay();
  }

  /**
   * TEST HOOK — move the playhead, in seconds.
   *
   * It exists because the one thing this module is FOR cannot otherwise be
   * observed inside a test: the tail fade and the loop seam are 85 and 210
   * seconds into their tracks, and a probe that waited for one would be a probe
   * nobody runs. Seeking to just before the end puts the seam a second away, so
   * `tools/test-music.mjs` can watch the envelope come down, the wrap happen and
   * the envelope come back up. Same shape and the same justification as
   * `__dbgHurt` in main.ts: a deterministic way to reach a state that otherwise
   * depends on waiting.
   */
  seek(t: number): void {
    if (this.el) this.el.currentTime = t;
  }

  debugState(): unknown {
    return {
      scene: this.scene,
      /** The file's basename, or null when nothing is loaded. */
      track: this.track ? this.track.split('/').pop() ?? this.track : null,
      loaded: this.el !== null,
      playing: this.el !== null && !this.el.paused,
      volume: this.master,
      /** What the element is actually at, i.e. master x envelope x swap. */
      output: this.el ? +this.el.volume.toFixed(3) : 0,
      at: this.el ? +this.el.currentTime.toFixed(2) : 0,
      duration: this.el && Number.isFinite(this.el.duration) ? +this.el.duration.toFixed(2) : 0,
      blocked: this.blocked,
      loops: this.loops,
      starts: this.starts,
    };
  }

  dispose(): void {
    this.unload();
    this.scene = null;
    this.pending = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Load and play one track, or nothing at all. Replaces whatever is loaded. */
  private start(url: string | null): void {
    this.unload();
    // THE GATE THE ISSUE ASKS FOR, and the only place it needs to be: at zero
    // there is no element, so there is no request and nothing to unload later.
    if (!url || this.master === 0) return;

    const el = new Audio();
    // Native looping: the wrap is the browser's business and is sample-exact,
    // where a `timeupdate` listener seeking to 0 fires at ~250 ms granularity
    // and would leave an audible hole at the seam the fades exist to hide.
    el.loop = true;
    el.preload = 'auto';
    // Starts SILENT and is raised by the first tick. Setting the master here
    // instead would play a frame or two at full volume before the envelope had
    // ever run, which is the click at the head of the track rather than the fade.
    el.volume = 0;
    el.src = url;
    this.el = el;
    this.track = url;
    this.swap = 1;
    this.swapTarget = 1;
    this.starts++;
    // Diagnostics only: `loop` means `ended` never fires, so the pass count comes
    // from watching `currentTime` go backwards in `tick`.
    this.lastAt = 0;
    this.tryPlay();
    if (!this.timer) this.timer = window.setInterval(this.tick, TICK_MS);
  }

  /** Where the playhead was last tick, for counting loops. */
  private lastAt = 0;

  private tryPlay(): void {
    const el = this.el;
    if (!el) return;
    const p = el.play();
    if (!p) { this.blocked = false; return; }
    p.then(() => {
      this.blocked = false;
      this.stopListening();
    }).catch(() => {
      // The autoplay policy, almost always — a page that has not been touched
      // may not make noise. Not an error and not logged: the retry below is the
      // handling, and a console warning on every cold load is noise of its own.
      this.blocked = true;
      this.listen();
    });
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    for (const ev of UNLOCK_EVENTS) {
      // CAPTURE phase, for the same reason core/input.ts stamps touches there:
      // the menu's own handlers call `stopPropagation()`, so a bubble listener
      // would never see the press that takes the player off the splash.
      window.addEventListener(ev, this.onGesture, true);
    }
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    for (const ev of UNLOCK_EVENTS) window.removeEventListener(ev, this.onGesture, true);
  }

  private onGesture = (): void => {
    if (this.el && this.blocked) this.tryPlay();
    else this.stopListening();
  };

  /** Stop, unload, and stop ticking. Idempotent. */
  private unload(): void {
    const el = this.el;
    this.el = null;
    this.track = null;
    this.blocked = false;
    this.stopListening();
    if (this.timer) { window.clearInterval(this.timer); this.timer = 0; }
    if (!el) return;
    el.pause();
    // THE UNLOAD, and it is these two lines rather than dropping the reference.
    // An element with a src is still a live media resource — buffered data, a
    // decoder, possibly a connection — and the GC is under no obligation to be
    // prompt about it. Emptying `src` and calling `load()` is the documented way
    // to tell the browser to let go of it now. `removeAttribute` rather than
    // `src = ''`, which resolves to the page's own URL and makes the element
    // fetch the HTML document.
    el.removeAttribute('src');
    el.load();
  }

  /**
   * The loop envelope at the current playhead, 0..1.
   *
   * Squared on the way out: `HTMLMediaElement.volume` is linear amplitude and
   * hearing is not, so a linear ramp spends most of its length in a range that
   * already sounds like full volume and then drops off a cliff at the end. The
   * square is the cheap standard fix and is what makes the two ends of the loop
   * meet without a bump.
   */
  private envelope(el: HTMLAudioElement): number {
    const dur = el.duration;
    const t = el.currentTime;
    // Metadata has not arrived yet, so the tail is unknown: fade in only. It
    // arrives within the first few hundred ms, long before FADE_OUT matters.
    const head = clamp01(t / FADE_IN);
    const tail = Number.isFinite(dur) && dur > 0 ? clamp01((dur - t) / FADE_OUT) : 1;
    const e = head < tail ? head : tail;
    return e * e;
  }

  /** Push master x envelope x swap at the element. */
  private apply(): void {
    const el = this.el;
    if (!el) return;
    el.volume = clamp01(this.master * this.envelope(el) * this.swap);
  }

  private tick = (): void => {
    const el = this.el;
    if (!el) { if (this.timer) { window.clearInterval(this.timer); this.timer = 0; } return; }

    // The swap ramp, stepped in wall-clock rather than in ticks so a throttled
    // background tab retires a track in the time it says rather than in however
    // many ticks it was given.
    if (this.swap !== this.swapTarget) {
      const step = TICK_MS / 1000 / FADE_SWAP;
      this.swap = this.swapTarget > this.swap
        ? Math.min(this.swapTarget, this.swap + step)
        : Math.max(this.swapTarget, this.swap - step);
      if (this.swap === 0) {
        // The outgoing track is out. Unload it and start whatever the scene
        // change that began this ramp asked for.
        const next = this.pending;
        this.pending = null;
        this.swap = 1;
        this.swapTarget = 1;
        this.start(next === null ? null : TRACKS[next] ?? null);
        return;
      }
    }

    if (el.currentTime < this.lastAt - 1) this.loops++;
    this.lastAt = el.currentTime;
    this.apply();
  };
}
