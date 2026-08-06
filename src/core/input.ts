/**
 * Which virtual device a stick reading came from.
 *
 * The sticks are the one part of this class that cannot be a single shared
 * value. A button is a button — touch and a gamepad both press `Space` and the
 * held set does not care which pushed it — but two analog sources that both
 * write one pair of axes fight: whichever reported last wins, so a resting
 * gamepad stick sitting at exactly zero would keep stamping out a live touch
 * stick fifty times a second. Tagging the source lets `axisFwd`/`axisSide`
 * arbitrate instead of racing.
 */
export type StickSource = 'touch' | 'gamepad';

/**
 * Which physical device the player last actually used.
 *
 * Distinct from `padActive`/`touchActive`, which are LATCHES answering "has this
 * device ever been used this session" — the right question for the start gate
 * and the welcome toast, and the wrong one for the HUD. A player who tries the
 * controller once and then plays on the keyboard for an hour was being shown
 * controller faces for that whole hour, because a latch cannot un-set.
 *
 * So this is stamped on every real input and never latched: whatever moved
 * last owns the labels, and the rumble. `'kbm'` to start, which is what the HUD
 * prints before anyone has touched anything.
 */
export type InputSource = 'kbm' | 'touch' | 'gamepad';

/**
 * Where `Input.takeLook` writes. The caller owns one and passes it in, so a read
 * on a simulation slice allocates nothing.
 */
export interface LookDelta {
  dx: number;
  dy: number;
  wheel: number;
}

/**
 * Input manager: WASD + mouse-look (pointer lock) and skill hotkeys, plus a
 * virtual layer that touch controls and the gamepad drive so gameplay code
 * never has to know which device it is reading.
 */
export class Input {
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /**
   * Presses since the last `debugState()`, which clears them.
   *
   * A separate latch rather than a read of `pressedThisFrame`, because that set
   * is wiped by `endFrame()` and a probe polled from outside the frame loop
   * would therefore almost always find it empty. A test written against the raw
   * set passes or fails on where the poll happened to land between frames,
   * which is the flakiest possible assertion. See tools/test-gamepad.mjs.
   */
  private pressedLatch = new Set<string>();
  /** Buttons held by the touch overlay or the pad (same codes as keyboard). */
  private virtualHeld = new Set<string>();
  /**
   * Look and zoom accumulated since a simulation slice last spent them.
   *
   * READ THEM WITH `takeLook`, never directly. They are QUANTITIES TO
   * INTEGRATE, and the frame loop drains a variable number of fixed slices —
   * see the note on that method for what reading them twice in one frame did.
   * Public because `debugState` reports them and the tools read that.
   */
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  pointerLocked = false;
  /**
   * Whether anyone currently WANTS the pointer, as opposed to holding it.
   *
   * `requestPointerLock()` resolves a tick or more after it is called, and
   * `document.pointerLockElement` stays null for that whole window — so
   * `releaseLock()` asking "is anything locked" got `no` and did nothing, and
   * the lock it was cancelling landed a moment later on whatever had replaced
   * the game. That is issue #29: `Exit to title` closes the in-game menu (which
   * hands the pointer BACK to the game, the right thing on Continue) and then
   * runs `exitToTitle`, which releases it — in that order, one frame apart.
   * The release lost the race, and the title screen came up with the pointer
   * captured by the canvas underneath it: no cursor, and every click on New
   * Game delivered to the world instead of to the button.
   *
   * Held here rather than fixed at either call site because the hazard belongs
   * to the pair, not to the pause menu: any future "take it, no, give it back"
   * within one turn of the event loop would have raced the same way. With this,
   * the LAST call wins whatever the browser's timing does — see the
   * `pointerlockchange` handler, which hangs up on a lock nobody wants any more.
   */
  private lockWanted = false;
  /**
   * Whether this window currently has the keyboard, tracked rather than asked.
   *
   * `document.hasFocus()` alone is not enough to tell an Escape from an alt-tab:
   * the two events that arrive on a focus loss — `blur` and `pointerlockchange`
   * — are dispatched by different parts of the browser, and nothing in either
   * spec fixes their order, so a `pointerlockchange` that lands first reads a
   * document that still holds focus. This latch closes that window from the
   * other side: it is false from the `blur` and stays false until `focus`, so
   * whichever of the two arrives first, one of the pair says "not focused".
   *
   * Seeded from `hasFocus()` because a page can boot in a background tab.
   */
  private focused = typeof document === 'undefined' || document.hasFocus();
  /**
   * The browser took the pointer while the game still wanted it.
   *
   * There is exactly one thing a player does that causes this, and it is the
   * reason this hook exists: pressing Escape. A page holding pointer lock does
   * not receive that key at all — the browser spends it on releasing the lock —
   * so the menu key silently did nothing on the press that mattered and worked
   * on the next one, which is what "Escape only opens the menu every other
   * time" was. Where the KEYBOARD LOCK is available (see ui/fullscreen.ts) that
   * never happens, because Escape is delivered as an ordinary key and the lock
   * is not dropped; where it is not — Brave nulls `navigator.keyboard` outright
   * — this is the only evidence the page gets that the key was pressed.
   *
   * NOT RAISED WHEN THE WINDOW LOST FOCUS, which is issue #79. The browser drops
   * the lock on an alt-tab, on a click into another window and on a
   * notification stealing focus, and every one of those arrived here looking
   * exactly like Escape — so the game paused itself behind the player's back and
   * they came back to a menu they never opened. Losing focus is not a request
   * for anything: the world keeps running and the hero keeps standing where he
   * was, and if the player wants the menu the key is still there. See `focused`.
   */
  onLockLost: (() => void) | null = null;
  /**
   * May a pointer the BROWSER took be taken back without a click? Written by
   * the host every frame; false whenever a cursor is the point.
   *
   * The host owns this because every reason to say no belongs to it and not
   * here: a modal is up, the hero is not playing, or Alt is being held to free
   * the cursor deliberately. See `armRelock` for what it gates.
   */
  autoRelock = false;
  /**
   * While true every GAMEPLAY read of this class answers "nothing pressed" —
   * held keys, press edges, both stick axes and the attack button.
   *
   * A PANEL TAKES THE INPUT, NOT THE CLOCK (issue #101). Every modal in this
   * game used to be a freeze: `simulate` skipped the player controller outright,
   * so a hero who opened the bag mid-jump hung in the air until it was closed
   * while the enemies swinging at him — which were never frozen — went on
   * moving. What a panel actually claims is the KEYBOARD, and that is all this
   * expresses: the controller still runs, so gravity, friction, the landing and
   * the swing already in flight all resolve, and they resolve with the sticks at
   * rest.
   *
   * SCOPED TO THE SIMULATION SLICE and nowhere else. `simulate` in main.ts sets
   * it around the gameplay block and clears it immediately after, because the
   * frame loop's OWN reads — Escape, F10, the panel navigation keys — are the
   * presses the modal is up to receive. Anything reading input outside that
   * window is unaffected, which is what keeps this a one-line policy rather than
   * a mode.
   */
  suspended = false;
  private attackDown = false;
  private attackEdge = false;
  /** True while the attack button is held. Suppressed by `suspended`. */
  get attackHeld(): boolean { return !this.suspended && this.attackDown; }
  /** True on the frame the attack button went down. Suppressed by `suspended`. */
  get attackPressed(): boolean { return !this.suspended && this.attackEdge; }
  /**
   * `performance.now()` when the browser took the pointer while the game still
   * wanted it, or 0 when there is nothing to recover. See `armRelock`.
   */
  private lockTakenAt = 0;
  /**
   * How long to wait before asking for the pointer back, in ms.
   *
   * NOT a debounce — it is Chrome's own rule, restated. A page that has just
   * had pointer lock taken by Escape is refused for about 1.25 s afterwards
   * (the anti-trap clause: a game that re-locked instantly would make Escape
   * useless), and a request inside that window is denied and logged. 1300 ms
   * clears it with a little room, and doubles as the retry interval so a player
   * holding W through the lockout asks once a second rather than 60 times.
   */
  private static readonly RELOCK_WAIT_MS = 1300;
  /**
   * Keys that mean "I am still playing" — the movement set plus the two things
   * a moving player does with them.
   *
   * DELIBERATELY NOT "any key". The pointer is also lost on the way into a
   * panel and on Alt, and the recovery must not fight either of those; a key
   * that steers the hero is the one unambiguous signal that the player is back
   * in the world and wants the mouse to turn the camera again.
   */
  private static readonly RESUME_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft',
  ]);

  /** Analog sticks per source, -1..1. See `StickSource` and `axisFwd`. */
  private touchFwd = 0;
  private touchSide = 0;
  private padFwd = 0;
  private padSide = 0;
  /** True while a touch look-drag is in progress. */
  private touchLooking = false;
  /** True while the pad's right stick is deflected past its deadzone. */
  private padLooking = false;
  /** Set once any touch input is seen, so we never mix modes mid-session. */
  touchActive = false;
  /**
   * Set once the pad has produced any input. A LATCH, and still the right shape
   * for what reads it — the start gate and the welcome toast, both of which ask
   * "is there a controller player here at all". What the HUD asks is
   * `lastSource`; see `InputSource`.
   */
  padActive = false;
  /** See `InputSource`. Written only through `noteSource`. */
  private source: InputSource = 'kbm';

  /** Keys the game owns — the browser must never act on these (Tab focus, Space scroll, quick-find, etc.) */
  private static readonly CAPTURED = new Set([
    'Tab', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ',
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'BracketLeft', 'BracketRight',
    'ShiftLeft', 'Slash', 'Quote',
    // FUNCTION KEYS AND ARROWS. Every one of these does something in a browser
    // — F1 opens its help in a new tab over the game, F3 opens quick-find, the
    // arrows scroll — so all of them have to be swallowed here.
    //
    // ADD A KEY TO THE GAME, ADD IT TO THIS SET. It has been forgotten twice
    // now, once per F-key, and the failure is invisible in a probe: puppeteer
    // dispatches the key straight at the page, the game reacts correctly, and
    // nothing opens a help tab because there is no browser chrome in a headless
    // run. It only ever shows up in a real browser, on a real player's machine.
    // tools/test-keybinds.mjs now cross-checks this set against the bindings
    // table so it is a run rather than a wish.
    //
    // Enter and KeyR are deliberately NOT here even though ui/perf-panel.ts
    // reads them. Enter has real default behaviour inside a text field and the
    // dev console handles its own in the capture phase; and this test is on the
    // CODE alone, so capturing KeyR would swallow Ctrl+R and take reloading the
    // page away with it.
    // F10 IS THE MENU KEY. It is here for the same reason as the three above —
    // Firefox and Edge focus their own menu bar on it, which takes the keyboard
    // away from the game — and unlike Escape this preventDefault is the WHOLE
    // fix, because a menu bar is ordinary page-level default behaviour rather
    // than a user-agent action taken over the page's head.
    'F1', 'F2', 'F3', 'F10',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    // ALT focuses the browser's own menu bar in Firefox and Edge, which steals
    // the keyboard from the game and cannot be got back without a click. It is
    // the cursor toggle (see setCursorFree in main.ts), so it is pressed often.
    'AltLeft', 'AltRight',
    // ESCAPE CLOSES THE TOPMOST PANEL — it no longer opens the menu, which is
    // F10's job now — and it is also the browser's key for leaving fullscreen
    // and for dropping pointer lock. This line alone does NOT stop either of
    // those: both are user-agent actions taken over the page's head, and for a
    // long time this set left Escape out for exactly that reason — "you cannot
    // preventDefault it" was true. It stopped being true with the KEYBOARD LOCK
    // the game takes on entering fullscreen (see ui/fullscreen.ts): under that
    // lock Escape is delivered to the page as an ordinary key and this
    // preventDefault is what keeps the browser out of it. Where there is no lock
    // — Firefox, Safari, an iframe, plain http — the call is harmless, the
    // browser drops the pointer, and `armRelock` is what puts it back.
    'Escape',
  ]);

  /** The capture list, for tools/test-keybinds.mjs. Read-only by convention. */
  static capturedCodes(): string[] {
    return [...Input.CAPTURED];
  }

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (Input.CAPTURED.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.noteSource('kbm');
      this.keys.add(e.code);
      this.press(e.code);
      // A KEYDOWN IS A USER ACTIVATION, which is what makes this the recovery
      // that actually works — see `armRelock`. It runs after `press` so the
      // frame the pointer comes back is also the frame the hero starts walking.
      if (Input.RESUME_KEYS.has(e.code)) this.armRelock();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('focus', () => { this.focused = true; });
    window.addEventListener('blur', () => {
      this.focused = false;
      this.keys.clear();
      this.virtualHeld.clear();
      this.attackDown = false;
      // Both sticks too: a pad held over on the moment focus is lost would
      // otherwise keep the hero walking into the void behind an alt-tab. The
      // pad re-reports its true state on the first poll after focus returns.
      this.touchFwd = this.touchSide = this.padFwd = this.padSide = 0;
      this.padLooking = false;
    });

    el.addEventListener('mousedown', (e) => {
      this.noteSource('kbm');
      // Through `requestLock` rather than straight to the DOM, so this way in
      // records the same intent the explicit callers do — it carries the touch
      // guard and the already-locked guard that used to be written out here.
      this.requestLock();
      if (e.button === 0) { this.attackDown = true; this.attackEdge = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attackDown = false;
    });
    document.addEventListener('pointerlockchange', () => {
      const had = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === el;
      // Back in hand: there is nothing left to recover, whoever asked.
      if (this.pointerLocked) this.lockTakenAt = 0;
      // THE LATE ARRIVAL. A lock granted after someone asked for it back is
      // handed straight back here, which is what makes `releaseLock` final
      // regardless of how long the browser took to answer the request it is
      // cancelling. See `lockWanted`.
      if (this.pointerLocked && !this.lockWanted) { document.exitPointerLock(); return; }
      // TAKEN, rather than given up. Every deliberate release goes through
      // `releaseLock`, which clears the intent first — so a lock that vanishes
      // while `lockWanted` still stands was taken by the BROWSER, and Escape is
      // how a player takes it. See `onLockLost`.
      if (had && !this.pointerLocked && this.lockWanted) {
        // The intent is dropped either way: the pointer is gone, and the next
        // click is what asks for it back. Only the NOTIFICATION is conditional.
        this.lockWanted = false;
        // ...unless the window lost focus, in which case the browser took the
        // lock because it was taking everything, and nothing was pressed. See
        // `focused` for why both halves are read.
        if (this.focused && document.hasFocus()) {
          // WHAT MAKES THE LOSS RECOVERABLE. Stamped here and nowhere else, so
          // only a pointer the BROWSER took is ever taken back — a release the
          // game asked for cleared `lockWanted` first and never reaches this
          // branch. An alt-tab does not stamp either: the player is not here.
          this.lockTakenAt = performance.now();
          this.onLockLost?.();
        }
      }
    });
    window.addEventListener('mousemove', (e) => {
      // A MOUSE MOVED OVER A GAME NOBODY IS CLICKING is the other half of the
      // signal, and the weaker one: it is not a user activation, so a browser
      // may well refuse. Asking costs a rejected promise nobody sees, and where
      // it is honoured the pointer comes back without the player pressing
      // anything at all. See `armRelock`.
      if (!this.pointerLocked) { this.armRelock(); return; }
      {
        // Gated on a NON-ZERO delta, not merely on the event. A locked pointer
        // still reports the odd 0/0 move, and the pad's own look goes through
        // `addLook` rather than this listener — so without the test a controller
        // player turning the camera could have the labels stolen back by a mouse
        // that never moved.
        if (e.movementX !== 0 || e.movementY !== 0) this.noteSource('kbm');
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    window.addEventListener('wheel', (e) => {
      this.noteSource('kbm');
      this.wheelDelta += e.deltaY;
    }, { passive: true });
  }

  /**
   * Record which device just produced input. See `InputSource`.
   *
   * Called from the listeners above, from `TouchControls` on the first touch of
   * a gesture, and from `GamepadControls.poll` on every frame the pad is being
   * used. Cheap on purpose — it is on the pad's per-frame path.
   */
  noteSource(s: InputSource): void { this.source = s; }

  /** The device the player last actually used. See `InputSource`. */
  get lastSource(): InputSource { return this.source; }

  /**
   * True while the device that last produced input is one the player is
   * HOLDING — a pad or a touchscreen.
   *
   * This is the haptics question, and it is deliberately not "is a pad
   * connected": rumble belongs to the thing in your hands, so a controller left
   * plugged in beside the keyboard must sit still, and a phone must keep
   * buzzing because a finger IS the device there.
   */
  get tactile(): boolean { return this.source !== 'kbm'; }

  private press(code: string): void {
    this.pressedThisFrame.add(code);
    this.pressedLatch.add(code);
  }

  down(code: string): boolean {
    if (this.suspended) return false;
    return this.keys.has(code) || this.virtualHeld.has(code);
  }

  /** True only on the frame the key went down */
  pressed(code: string): boolean {
    return !this.suspended && this.pressedThisFrame.has(code);
  }

  /**
   * True on the frame the key went down — and CONSUMES the edge.
   *
   * This is the read for a FRAME-loop toggle; `pressed()` is the read for a
   * SIMULATION slice. What separates them is `endFrame()`, which only runs on a
   * frame that actually drained a slice — see its call site in main.ts. A press
   * therefore SURVIVES frames that ran no simulation, deliberately, because
   * throwing it away was losing a third of every player's jumps.
   *
   * That is exactly wrong for a toggle. Uncapped at 165 Hz against a 60 Hz sim,
   * roughly two frames in three drain nothing, so one press of F1 was read on
   * two or three consecutive frames and toggled itself straight back off:
   * measured, ten presses opened and closed the controls sheet in the pattern
   * `0011011101` where `1010101010` is correct. At `fps=30` every frame drains
   * two slices and the bug cannot occur, which is why every probe in tools/
   * passed while the game misbehaved in the hand.
   *
   * The probe latch is untouched on purpose: `debugState` answers "what has been
   * pressed since you last asked", which is a different question with a
   * different consumer.
   */
  takePress(code: string): boolean {
    return !this.suspended && this.pressedThisFrame.delete(code);
  }

  /**
   * True while look input should drive the camera.
   *
   * The pad's clause is load-bearing rather than symmetric: a player on a
   * controller never clicks, so `pointerLocked` stays false for their whole
   * session and without this the camera would simply never turn for them.
   */
  get lookActive(): boolean {
    return this.pointerLocked || this.touchLooking || this.padLooking;
  }

  /**
   * The winning stick pair, or null when neither source is deflected.
   *
   * Compared on the PAIR, not per axis. Picking the larger of `touchSide` and
   * `padSide` independently of the forward axes would let a diagonal push on
   * one device have its strafe stolen by a stale reading on the other, which
   * comes out as a hero who walks a different direction than the stick points.
   */
  private stick(): { side: number; fwd: number } | null {
    const t = this.touchSide * this.touchSide + this.touchFwd * this.touchFwd;
    const p = this.padSide * this.padSide + this.padFwd * this.padFwd;
    if (t <= 0 && p <= 0) return null;
    return t >= p
      ? { side: this.touchSide, fwd: this.touchFwd }
      : { side: this.padSide, fwd: this.padFwd };
  }

  /** Forward axis, -1..1: analog stick if deflected, else W/S. */
  get axisFwd(): number {
    if (this.suspended) return 0;
    const kb = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    return kb !== 0 ? kb : (this.stick()?.fwd ?? 0);
  }

  /** Strafe axis, -1..1: analog stick if deflected, else D/A. */
  get axisSide(): number {
    if (this.suspended) return 0;
    const kb = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return kb !== 0 ? kb : (this.stick()?.side ?? 0);
  }

  // ---- virtual (touch / gamepad) input -------------------------------------

  /**
   * Analog movement from a virtual stick, clamped to the unit disc.
   *
   * `source` defaults to touch so the overlay's four call sites read as they
   * always did. Either source releasing to zero yields the axes to the other
   * for free, which is what keeps the touch overlay's release-to-zero contract
   * intact now that it is no longer the only writer.
   */
  setStick(side: number, fwd: number, source: StickSource = 'touch'): void {
    const len = Math.hypot(side, fwd);
    if (len > 1) { side /= len; fwd /= len; }
    if (source === 'gamepad') {
      this.padSide = side;
      this.padFwd = fwd;
    } else {
      this.touchSide = side;
      this.touchFwd = fwd;
    }
  }

  /** Feed a look drag (in the same units as mouse movement). */
  addLook(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** Feed a zoom step (in the same units as a wheel notch). */
  addWheel(delta: number): void { this.wheelDelta += delta; }

  /**
   * Hand the accumulated look and zoom to the camera — and CONSUME them, so a
   * second simulation slice in the same rendered frame gets nothing.
   *
   * THIS IS THE OTHER HALF OF THE `takePress` / `pressed` RULE, and it runs the
   * opposite way round. A key EDGE has to survive frames that drained no slice,
   * because a tap shorter than 16.7 ms would otherwise be thrown away — so
   * `endFrame()` only clears on a frame that ran one. Look delta is not an edge
   * but a QUANTITY, and it wants the same survival across slice-less frames
   * (integrating it over wall-clock is what keeps a mouse honest at 165 Hz) and
   * the exact opposite behaviour when a frame runs SEVERAL slices: clearing
   * after the loop meant every slice in that frame re-applied the SAME delta,
   * so the camera turned once per slice.
   *
   * That is issue #37. Measured with the pad's look stick held at full
   * deflection, degrees of yaw per second, against a nominal ~184:
   *
   *   fps=120  174     fps=60  221     fps=40  263     fps=30  350   fps=20  511
   *
   * i.e. sensitivity multiplied by the slice count — 1x above 60 fps, 2x at 30,
   * 3x at 20, and up to `MAX_STEPS` = 4x on a single long frame. A fight is
   * exactly where those land (a hit spawns a burst, a damage number, a screen
   * flash and sometimes a light count nothing has linked a program for yet), so
   * the report is a camera that "all of a sudden moves around" when something
   * connects — one hitched frame spending 300 ms of mouse movement four times.
   *
   * Consumed here rather than at the end of the slice loop because the camera is
   * the only reader (`ThirdPersonCamera.update`), and a quantity with one
   * consumer should be spent where it is spent. `endFrame` still clears as a
   * backstop for the frames no camera update runs at all — photo mode.
   */
  takeLook(out: LookDelta): void {
    out.dx = this.mouseDX;
    out.dy = this.mouseDY;
    out.wheel = this.wheelDelta;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  /**
   * Take the pointer, if there is one to take.
   *
   * The `mousedown` listener in the constructor is the usual way in, and it
   * cannot be the only one: New Game is a click on a BUTTON, so the world never
   * sees a mousedown and the player arrives in the game with a cursor over it
   * and no mouse look until they click again. `beginPlay` in main.ts calls this.
   *
   * Same touch guard as mousedown, and the rejection is SWALLOWED rather than
   * reported. A browser refuses a lock with no user activation behind it, which
   * is exactly what an unstaged `menu=0` boot is — every probe in tools/ — and
   * nothing is lost when it fails: the next click in the world takes the lock
   * the way it always did.
   */
  requestLock(): void {
    if (this.touchActive) return;
    // Recorded even when the lock is already held, so that a `releaseLock`
    // arriving later has something to clear. The flag is the intent; the
    // browser's answer is `pointerLocked`.
    this.lockWanted = true;
    if (this.pointerLocked) return;
    // Older DOM lib types this `void`, newer ones a Promise. Both ship.
    const pending = this.el.requestPointerLock() as unknown;
    if (pending instanceof Promise) pending.catch(() => {});
  }

  /**
   * ASK FOR A POINTER THE BROWSER TOOK, if the player looks like they want it.
   *
   * THE PROBLEM. Escape releases pointer lock, always, on every browser — the
   * keyboard lock only covers a document that is FULLSCREEN, so a windowed game
   * has no say in it at all. Pressing Escape to close a panel therefore left the
   * player standing in the world with mouse look dead and no indication why, and
   * the only way back was a click, which in a game whose left button swings a
   * sword is a click they did not mean to make.
   *
   * WHAT COUNTS AS WANTING IT. Moving. A movement keydown (`RESUME_KEYS`) or a
   * mouse being moved over a game with no cursor on it — nothing else, and in
   * particular not "any key", because the pointer is also released on the way
   * into every panel and by Alt, and a recovery that fought those would take the
   * cursor away from the menu the player just opened. The host's `autoRelock`
   * carries the rest of that judgement.
   *
   * IT IS RATE-LIMITED BY THE BROWSER'S OWN RULE, not by taste — see
   * `RELOCK_WAIT_MS`. Re-stamping on every attempt is what turns the wait into a
   * retry interval, so a player who holds W through the lockout asks again once
   * it lifts rather than sixty times inside it.
   *
   * Nothing here is a decision about the MENU. That was the old answer to this
   * same event (`onLockLost` tapped a virtual Escape, so a stolen pointer opened
   * the in-game menu) and it is gone with the move to F10: losing the pointer is
   * not a request for a menu, it is a pointer to put back.
   */
  armRelock(): void {
    if (!this.autoRelock || this.lockTakenAt === 0) return;
    if (this.pointerLocked || this.touchActive) return;
    const now = performance.now();
    if (now - this.lockTakenAt < Input.RELOCK_WAIT_MS) return;
    this.lockTakenAt = now;
    this.requestLock();
  }

  /** Whether a pointer taken by the browser is still waiting to be recovered. */
  get relockPending(): boolean { return this.lockTakenAt !== 0; }

  /**
   * Give the pointer back, if this page holds it.
   *
   * The counterpart of `requestLock`, and it exists for the modals that are
   * CLICKED rather than read: the in-game menu has a cursor that has to reach
   * three buttons and a settings list, and a locked pointer has no cursor at
   * all. The F1 sheet deliberately does not call this — see `clearLook` below
   * for what it does instead and why.
   *
   * Safe to call when nothing is locked — and, since issue #29, safe to call
   * while a lock is still IN FLIGHT, which is the case the old one-line body
   * could not express. Clearing the intent is the half that survives the wait;
   * `exitPointerLock` only covers a lock the browser has already granted.
   */
  releaseLock(): void {
    this.lockWanted = false;
    // A DELIBERATE RELEASE CANCELS A PENDING RECOVERY. Escape closing a panel
    // and the next panel opening are two events a few ms apart, and without
    // this the second one would be undone by a recovery armed by the first.
    this.lockTakenAt = 0;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * Throw away look and zoom accumulated but not yet consumed.
   *
   * For a modal that KEEPS pointer lock — the F1 controls sheet. The mouse goes
   * on reporting movement into `mouseDX` while the panel is up, and the camera
   * must not spend it: reading a sheet is not aiming. `frame()` in main.ts calls
   * this on every frame with a modal open, which is what keeps the arm still
   * both WHILE the sheet is up and on the frame it closes — a whole reading
   * session's worth of delta would otherwise land as one flick. The shop never
   * needed it because it releases the lock, and `mousemove` is gated on holding
   * it.
   *
   * It is the LOOK half of what `suspended` does for the buttons, and stays a
   * separate call because it is the host's per-FRAME decision while suspension
   * is scoped to the simulation block.
   */
  clearLook(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  setTouchLooking(v: boolean): void { this.touchLooking = v; }
  setPadLooking(v: boolean): void { this.padLooking = v; }

  /** Hold/release a virtual button using its keyboard-equivalent code. */
  setVirtualButton(code: string, held: boolean): void {
    if (held) {
      if (!this.virtualHeld.has(code)) this.press(code);
      this.virtualHeld.add(code);
    } else {
      this.virtualHeld.delete(code);
    }
  }

  /** Fire a one-frame virtual press (buttons that aren't held, e.g. skills). */
  tapVirtual(code: string): void { this.press(code); }

  setVirtualAttack(held: boolean): void {
    if (held && !this.attackDown) this.attackEdge = true;
    this.attackDown = held;
  }

  /**
   * Call at end of each frame that actually drained a simulation slice.
   *
   * The look/zoom clear is a BACKSTOP now rather than the mechanism: a camera
   * update spends them through `takeLook` on the first slice of the frame, and
   * what is left here is the frames where no camera update runs at all (photo
   * mode drives the lens itself). Clearing them twice costs nothing; leaving a
   * frame's worth of delta to be spent by a later, unrelated slice does not.
   */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.attackEdge = false;
    this.pressedThisFrame.clear();
  }

  /**
   * Read-only snapshot for `__dbgInput`. Allocates, and CONSUMES the press
   * latch — never call it from the frame loop.
   *
   * The held set is spelled out rather than dumped wholesale because the codes
   * gameplay actually reads are the contract worth asserting on; a raw dump
   * would also carry every key a player happened to be leaning on.
   */
  debugState(): unknown {
    const held: Record<string, boolean> = {};
    for (const code of [
      'Space', 'ShiftLeft', 'KeyF', 'KeyC', 'KeyE', 'Tab',
      'BracketLeft', 'BracketRight', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
    ]) held[code] = this.down(code);
    const pressedSince = [...this.pressedLatch];
    this.pressedLatch.clear();
    return {
      held,
      pressedSince,
      attackHeld: this.attackDown,
      attackPressed: this.attackEdge,
      mouseDX: this.mouseDX,
      mouseDY: this.mouseDY,
      wheelDelta: this.wheelDelta,
      padActive: this.padActive,
      lastSource: this.source,
      tactile: this.tactile,
      padLooking: this.padLooking,
      stick: {
        touch: { side: this.touchSide, fwd: this.touchFwd },
        pad: { side: this.padSide, fwd: this.padFwd },
      },
    };
  }
}
