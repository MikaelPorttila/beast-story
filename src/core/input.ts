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
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  pointerLocked = false;
  attackHeld = false;
  attackPressed = false;

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
    'F2', // debug overlay — must not reach the browser
  ]);

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (Input.CAPTURED.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.noteSource('kbm');
      this.keys.add(e.code);
      this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.virtualHeld.clear();
      this.attackHeld = false;
      // Both sticks too: a pad held over on the moment focus is lost would
      // otherwise keep the hero walking into the void behind an alt-tab. The
      // pad re-reports its true state on the first poll after focus returns.
      this.touchFwd = this.touchSide = this.padFwd = this.padSide = 0;
      this.padLooking = false;
    });

    el.addEventListener('mousedown', (e) => {
      this.noteSource('kbm');
      // Never grab the pointer on a touch device: it would hide the finger's
      // own cursorless interaction model and break the overlay.
      if (!this.pointerLocked && !this.touchActive) el.requestPointerLock();
      if (e.button === 0) { this.attackHeld = true; this.attackPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attackHeld = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === el;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
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
    return this.keys.has(code) || this.virtualHeld.has(code);
  }

  /** True only on the frame the key went down */
  pressed(code: string): boolean { return this.pressedThisFrame.has(code); }

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
    const kb = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    return kb !== 0 ? kb : (this.stick()?.fwd ?? 0);
  }

  /** Strafe axis, -1..1: analog stick if deflected, else D/A. */
  get axisSide(): number {
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
    if (held && !this.attackHeld) this.attackPressed = true;
    this.attackHeld = held;
  }

  /** Call at end of each frame */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.attackPressed = false;
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
      attackHeld: this.attackHeld,
      attackPressed: this.attackPressed,
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
