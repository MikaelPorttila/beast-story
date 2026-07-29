import type { Input } from './input';

/**
 * Touch controls: a left analog stick for movement, a right look-drag pad, and
 * action buttons (attack, jump, interact, four skills, pal swap).
 *
 * The overlay is only created on devices that actually have a touch screen; on
 * mouse/keyboard machines `TouchControls.attach` returns null and nothing is
 * added to the DOM, so there is no overlay and no per-frame cost.
 */

/**
 * True only when touch is the device's PRIMARY pointer.
 *
 * Note `'ontouchstart' in window` is useless for this: desktop Chrome exposes
 * touch events regardless of hardware, so testing it puts a joystick overlay on
 * every desktop. Touch points plus a coarse primary pointer is the reliable
 * signal. Hybrid machines (touchscreen laptop with a mouse) report a *fine*
 * primary pointer and are handled by lazy activation instead — see `attach`.
 */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  const points = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return points > 0 && coarse;
}

/** True when the hardware can produce touches at all (may also have a mouse). */
export function hasTouchCapability(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0;
}

const CSS = `
.cp-touch{position:fixed;inset:0;z-index:30;pointer-events:none;touch-action:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.cp-touch.hidden{display:none}

/* left: movement stick. The base only appears once a finger lands.
   Inset 28px from the left and bottom edges: at 14px the ring visually collided
   with (and on rounded-corner phones was clipped by) the viewport edge. */
.cp-stick{position:absolute;left:max(28px,env(safe-area-inset-left));
  bottom:max(28px,env(safe-area-inset-bottom));
  width:min(31vw,132px);aspect-ratio:1;pointer-events:auto;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.09),rgba(255,255,255,.03) 70%);
  border:1px solid rgba(255,255,255,.16);transition:opacity .2s ease;opacity:.55}
.cp-stick.active{opacity:1}
.cp-stick .knob{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;margin:0;
  transform:translate(-50%,-50%);border-radius:50%;
  background:radial-gradient(circle at 36% 30%,rgba(255,255,255,.9),rgba(210,228,245,.55) 60%,rgba(150,180,210,.4));
  box-shadow:0 4px 14px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.6)}

/* right half of the screen is the look pad (behind the buttons) */
.cp-look{position:absolute;right:0;top:0;width:52%;height:78%;pointer-events:auto}

/* action buttons, bottom-right cluster */
.cp-btns{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));
  display:grid;grid-template-columns:repeat(3,1fr);gap:10px;pointer-events:none}
.cp-btn{pointer-events:auto;display:grid;place-items:center;border-radius:50%;
  width:clamp(46px,13vw,66px);aspect-ratio:1;
  background:linear-gradient(165deg,rgba(34,44,62,.82),rgba(16,20,30,.88));
  border:1px solid rgba(255,255,255,.18);color:#eef2f8;
  font-weight:800;font-size:clamp(10px,2.6vw,12px);letter-spacing:.04em;
  box-shadow:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .08s ease,filter .08s ease}
.cp-btn:active,.cp-btn.on{transform:scale(.92);filter:brightness(1.5)}
.cp-btn.attack{width:clamp(58px,17vw,84px);
  background:linear-gradient(165deg,rgba(214,86,52,.9),rgba(150,48,26,.92));
  grid-column:3;grid-row:1/span 2;align-self:end}
.cp-btn.jump{grid-column:2;grid-row:2}
.cp-btn.interact{grid-column:1;grid-row:2}
.cp-btn.swap{grid-column:1;grid-row:1;
  background:linear-gradient(165deg,rgba(52,96,150,.85),rgba(24,52,92,.9))}

/* Skills sit above the action cluster, mirroring the desktop hotbar order.
   The offset is derived from the cluster instead of guessed: the button grid is
   two rows of clamp(46px,13vw,66px) with a 10px gap, so 2*row + gap clears it
   exactly and the trailing 12px is the breathing room the critic asked for.
   (The old fixed clamp(118px,30vw,168px) under-cleared the SWAP/ATK cluster at
   some widths, so the 1-4 row overlapped it.) */
.cp-skills{position:absolute;right:max(14px,env(safe-area-inset-right));
  bottom:calc(max(18px,env(safe-area-inset-bottom)) + 2 * clamp(46px,13vw,66px) + 22px);
  display:flex;gap:8px;pointer-events:none}
.cp-skill{pointer-events:auto;width:clamp(42px,11.5vw,54px);aspect-ratio:1;border-radius:14px;
  display:grid;place-items:center;font-weight:900;font-size:clamp(13px,3.4vw,16px);color:#eef2f8;
  background:linear-gradient(165deg,rgba(30,38,54,.8),rgba(14,18,28,.86));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 5px 14px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.09);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .08s ease,filter .08s ease}
.cp-skill:active{transform:scale(.9);filter:brightness(1.5)}

/* very short screens (landscape phones): pull everything in */
@media (max-height: 460px){
  .cp-stick{width:min(30vw,132px);left:max(20px,env(safe-area-inset-left));
    bottom:max(20px,env(safe-area-inset-bottom))}
  /* same derivation as above, with the landscape 7px grid gap */
  .cp-skills{bottom:calc(max(18px,env(safe-area-inset-bottom)) + 2 * clamp(46px,13vw,66px) + 19px);
    gap:7px}
  .cp-btns{gap:7px}
}
`;

interface StickState {
  id: number;
  cx: number;
  cy: number;
  radius: number;
}

export class TouchControls {
  private root: HTMLDivElement;
  private stickEl: HTMLDivElement;
  private knobEl: HTMLDivElement;
  private stick: StickState | null = null;
  private lookId: number | null = null;
  private lookX = 0;
  private lookY = 0;
  /** Look sensitivity relative to mouse movement pixels. */
  private static readonly LOOK_GAIN = 1.35;

  /**
   * Builds the overlay on touch-primary devices. On hybrid machines (touch
   * capable but mouse-primary) it stays dormant and builds itself on the first
   * real touch, so a desktop with a touchscreen never gets a joystick unless
   * the user actually touches the screen. On pure mouse hardware it returns
   * null and nothing is created or listened for.
   */
  static attach(input: Input, onSkill?: (index: number) => void): TouchControls | null {
    if (isTouchPrimary()) return new TouchControls(input, onSkill);
    if (!hasTouchCapability()) return null;

    let built: TouchControls | null = null;
    const onFirstTouch = (): void => {
      if (built) return;
      window.removeEventListener('touchstart', onFirstTouch);
      input.touchActive = true;
      built = new TouchControls(input, onSkill);
    };
    window.addEventListener('touchstart', onFirstTouch, { passive: true });
    return null; // caller keeps working with keyboard/mouse until a touch lands
  }

  private constructor(private input: Input, onSkill?: (index: number) => void) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'cp-touch';

    // -- look pad (added first so buttons stack above it) --------------------
    const look = document.createElement('div');
    look.className = 'cp-look';
    this.root.appendChild(look);
    look.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (this.lookId !== null) return;
      this.lookId = t.identifier;
      this.lookX = t.clientX;
      this.lookY = t.clientY;
      this.input.setTouchLooking(true);
      e.preventDefault();
    }, { passive: false });

    // -- movement stick ------------------------------------------------------
    this.stickEl = document.createElement('div');
    this.stickEl.className = 'cp-stick';
    this.knobEl = document.createElement('div');
    this.knobEl.className = 'knob';
    this.stickEl.appendChild(this.knobEl);
    this.root.appendChild(this.stickEl);
    this.stickEl.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      const r = this.stickEl.getBoundingClientRect();
      this.stick = {
        id: t.identifier,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        radius: r.width * 0.42,
      };
      this.stickEl.classList.add('active');
      this.applyStick(t.clientX, t.clientY);
      e.preventDefault();
    }, { passive: false });

    // -- skills --------------------------------------------------------------
    const skills = document.createElement('div');
    skills.className = 'cp-skills';
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.className = 'cp-skill';
      b.textContent = String(i + 1);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.tapVirtual(`Digit${i + 1}`);
        onSkill?.(i);
      }, { passive: false });
      skills.appendChild(b);
    }
    this.root.appendChild(skills);

    // -- action buttons ------------------------------------------------------
    const btns = document.createElement('div');
    btns.className = 'cp-btns';
    const mkButton = (
      cls: string, label: string,
      onDown: () => void, onUp?: () => void,
    ): void => {
      const b = document.createElement('button');
      b.className = `cp-btn ${cls}`;
      b.textContent = label;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('on');
        onDown();
      }, { passive: false });
      const release = (): void => { b.classList.remove('on'); onUp?.(); };
      b.addEventListener('touchend', release);
      b.addEventListener('touchcancel', release);
      btns.appendChild(b);
    };

    mkButton('attack', 'ATK',
      () => this.input.setVirtualAttack(true),
      () => this.input.setVirtualAttack(false));
    mkButton('jump', 'JUMP',
      () => this.input.setVirtualButton('Space', true),
      () => this.input.setVirtualButton('Space', false));
    mkButton('interact', 'USE', () => this.input.tapVirtual('KeyE'));
    mkButton('swap', 'SWAP', () => this.input.tapVirtual('Tab'));
    this.root.appendChild(btns);

    document.body.appendChild(this.root);

    // Global move/end handling so a finger that slides off its control keeps working.
    window.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick && t.identifier === this.stick.id) {
          this.applyStick(t.clientX, t.clientY);
          e.preventDefault();
        } else if (this.lookId !== null && t.identifier === this.lookId) {
          this.input.addLook(
            (t.clientX - this.lookX) * TouchControls.LOOK_GAIN,
            (t.clientY - this.lookY) * TouchControls.LOOK_GAIN,
          );
          this.lookX = t.clientX;
          this.lookY = t.clientY;
          e.preventDefault();
        }
      }
    }, { passive: false });

    const endTouch = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick && t.identifier === this.stick.id) {
          this.stick = null;
          this.input.setStick(0, 0);
          this.stickEl.classList.remove('active');
          this.knobEl.style.transform = 'translate(-50%,-50%)';
        } else if (this.lookId !== null && t.identifier === this.lookId) {
          this.lookId = null;
          this.input.setTouchLooking(false);
        }
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    // First real touch anywhere marks the session as touch-driven, which also
    // stops the mouse handler from grabbing pointer lock.
    window.addEventListener('touchstart', () => { this.input.touchActive = true; }, { passive: true });
  }

  private applyStick(x: number, y: number): void {
    if (!this.stick) return;
    const dx = x - this.stick.cx;
    const dy = y - this.stick.cy;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, this.stick.radius);
    const nx = (dx / len) * (clamped / this.stick.radius);
    const ny = (dy / len) * (clamped / this.stick.radius);
    // screen-down is -forward
    this.input.setStick(nx, -ny);
    const px = (dx / len) * clamped;
    const py = (dy / len) * clamped;
    this.knobEl.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
  }

  /** Hide the overlay (e.g. while a modal shop is open). */
  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.stick = null;
      this.input.setStick(0, 0);
      this.input.setTouchLooking(false);
      this.input.setVirtualAttack(false);
      this.input.setVirtualButton('Space', false);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
