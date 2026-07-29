/**
 * Input manager: WASD + mouse-look (pointer lock) and skill hotkeys, plus a
 * virtual layer that touch controls drive so gameplay code never has to know
 * which device it is reading.
 */
export class Input {
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /** Buttons held by the touch overlay (same codes as keyboard). */
  private virtualHeld = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  pointerLocked = false;
  attackHeld = false;
  attackPressed = false;

  /** Analog stick, -1..1. Zero when no stick is active; keyboard wins if pressed. */
  private stickFwd = 0;
  private stickSide = 0;
  /** True while a touch look-drag is in progress. */
  private touchLooking = false;
  /** Set once any touch input is seen, so we never mix modes mid-session. */
  touchActive = false;

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
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.virtualHeld.clear();
      this.attackHeld = false;
    });

    el.addEventListener('mousedown', (e) => {
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
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    window.addEventListener('wheel', (e) => { this.wheelDelta += e.deltaY; }, { passive: true });
  }

  down(code: string): boolean {
    return this.keys.has(code) || this.virtualHeld.has(code);
  }

  /** True only on the frame the key went down */
  pressed(code: string): boolean { return this.pressedThisFrame.has(code); }

  /** True while look input should drive the camera (mouse captured, or a touch drag). */
  get lookActive(): boolean { return this.pointerLocked || this.touchLooking; }

  /** Forward axis, -1..1: analog stick if deflected, else W/S. */
  get axisFwd(): number {
    const kb = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    return kb !== 0 ? kb : this.stickFwd;
  }

  /** Strafe axis, -1..1: analog stick if deflected, else D/A. */
  get axisSide(): number {
    const kb = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return kb !== 0 ? kb : this.stickSide;
  }

  // ---- virtual (touch) input -----------------------------------------------

  /** Analog movement from a virtual stick. Values are clamped to the unit disc. */
  setStick(side: number, fwd: number): void {
    const len = Math.hypot(side, fwd);
    if (len > 1) { side /= len; fwd /= len; }
    this.stickSide = side;
    this.stickFwd = fwd;
  }

  /** Feed a look drag (in the same units as mouse movement). */
  addLook(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  setTouchLooking(v: boolean): void { this.touchLooking = v; }

  /** Hold/release a virtual button using its keyboard-equivalent code. */
  setVirtualButton(code: string, held: boolean): void {
    if (held) {
      if (!this.virtualHeld.has(code)) this.pressedThisFrame.add(code);
      this.virtualHeld.add(code);
    } else {
      this.virtualHeld.delete(code);
    }
  }

  /** Fire a one-frame virtual press (buttons that aren't held, e.g. skills). */
  tapVirtual(code: string): void { this.pressedThisFrame.add(code); }

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
}
