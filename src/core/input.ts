/**
 * Input manager: WASD movement, mouse-look (pointer lock), skill hotkeys.
 */
export class Input {
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  pointerLocked = false;
  attackHeld = false;
  attackPressed = false;

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
    window.addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) el.requestPointerLock();
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

  down(code: string): boolean { return this.keys.has(code); }
  /** True only on the frame the key went down */
  pressed(code: string): boolean { return this.pressedThisFrame.has(code); }

  /** Call at end of each frame */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.attackPressed = false;
    this.pressedThisFrame.clear();
  }
}
